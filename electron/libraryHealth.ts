import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'fast-glob';
import sharp from 'sharp';
import decodeHeic from 'heic-decode';
import ExifReader from 'exifreader';
import { loadLibraryMeta } from './libraryMeta';
import { isWithin } from './pathAccess';
import { scanDirectory } from './fileScanner';

export type LibraryHealthCategory = 'corrupt' | 'tiny' | 'unsupported' | 'missing-date' | 'orphan-sidecar';

export interface LibraryHealthIssue {
    category: LibraryHealthCategory;
    path: string;
    detail: string;
}

export interface LibraryHealthReport {
    roots: string[];
    scannedFiles: number;
    issues: LibraryHealthIssue[];
    summary: Record<LibraryHealthCategory, number>;
}

export interface QuarantinedFile {
    source: string;
    destination: string;
}

export interface QuarantineEntry {
    root: string;
    originalPath: string;
    quarantinePath: string;
    size: number;
    quarantinedAt: string | null;
}

export interface RestoredQuarantineFile {
    quarantinePath: string;
    restoredPath: string;
}

interface QuarantineManifestEntry {
    original: string;
    quarantined: string;
    quarantinedAt: string;
}

interface QuarantineManifest {
    version: 1;
    entries: QuarantineManifestEntry[];
}

const QUARANTINE_DIR = '.photo-slap-quarantine';
const QUARANTINE_MANIFEST = '.manifest.json';

const UNSUPPORTED_MEDIA_EXTENSIONS = new Set([
    '.avif', '.jfif', '.jxl', '.svg', '.tif', '.tiff',
    '.3gp', '.avi', '.m2ts', '.m4v', '.mkv', '.mov', '.mts', '.wmv',
    '.cr2', '.cr3', '.dng', '.nef', '.orf', '.raf', '.raw', '.rw2',
]);

const emptySummary = (): Record<LibraryHealthCategory, number> => ({
    corrupt: 0,
    tiny: 0,
    unsupported: 0,
    'missing-date': 0,
    'orphan-sidecar': 0,
});

async function readHead(filePath: string, maxBytes = 256 * 1024): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function hasCaptureDate(buffer: Buffer): boolean {
    try {
        const tags = ExifReader.load(buffer);
        return !!(tags.DateTimeOriginal || tags.DateTimeDigitized || tags.CreateDate);
    } catch {
        return false;
    }
}

function validVideoHeader(ext: string, header: Buffer): boolean {
    if (ext === '.mp4' || ext === '.gifv') return header.length >= 12 && header.subarray(4, 12).includes(Buffer.from('ftyp'));
    if (ext === '.webm') return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (ext === '.ogg') return header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'OggS';
    return false;
}

async function inspectMediaFile(file: { path: string; type: 'image' | 'video' }): Promise<LibraryHealthIssue[]> {
    const issues: LibraryHealthIssue[] = [];
    const ext = path.extname(file.path).toLowerCase();
    let stat;
    try {
        stat = await fs.stat(file.path);
    } catch {
        return [{ category: 'corrupt', path: file.path, detail: 'File is missing or unreadable.' }];
    }

    if (file.type === 'video') {
        try {
            const header = await readHead(file.path, 64);
            if (!validVideoHeader(ext, header)) {
                issues.push({ category: 'corrupt', path: file.path, detail: 'The video header is invalid or unreadable.' });
            }
        } catch {
            issues.push({ category: 'corrupt', path: file.path, detail: 'The video could not be read.' });
        }
        return issues;
    }

    let width = 0;
    let height = 0;
    try {
        if (ext === '.heic' || ext === '.heif') {
            const decoded = await decodeHeic({ buffer: await fs.readFile(file.path) });
            width = decoded.width;
            height = decoded.height;
        } else {
            const metadata = await sharp(file.path, { animated: true }).metadata();
            width = metadata.width ?? 0;
            height = metadata.height ?? 0;
        }
        if (!width || !height) throw new Error('No dimensions');
    } catch {
        issues.push({ category: 'corrupt', path: file.path, detail: 'The image could not be decoded.' });
        return issues;
    }

    if (stat.size < 10 * 1024 || width < 320 || height < 320) {
        issues.push({
            category: 'tiny',
            path: file.path,
            detail: `${width}×${height}, ${Math.max(1, Math.round(stat.size / 1024))} KB — smaller than the 320 px / 10 KB health threshold.`,
        });
    }

    try {
        if (!hasCaptureDate(await readHead(file.path))) {
            issues.push({ category: 'missing-date', path: file.path, detail: 'No embedded capture date was found.' });
        }
    } catch {
        issues.push({ category: 'missing-date', path: file.path, detail: 'No embedded capture date was found.' });
    }
    return issues;
}

export async function scanLibraryHealth(roots: string[]): Promise<LibraryHealthReport> {
    const normalizedRoots = [...new Set(roots.map(root => path.resolve(root)))];
    const supported = [] as { path: string; type: 'image' | 'video' }[];
    const issues: LibraryHealthIssue[] = [];

    for (const root of normalizedRoots) {
        const scan = await scanDirectory(root);
        supported.push(...scan.files);
        const allFiles = await glob('**/*', {
            cwd: root.replace(/\\/g, '/'), absolute: true, onlyFiles: true, dot: false,
        });
        for (const filePath of allFiles) {
            const ext = path.extname(filePath).toLowerCase();
            if (UNSUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
                issues.push({ category: 'unsupported', path: path.normalize(filePath), detail: `${ext || 'Unknown'} media is not supported by photo-slap.` });
            }
        }
    }

    let next = 0;
    const inspectWorker = async () => {
        while (next < supported.length) {
            const file = supported[next++];
            issues.push(...await inspectMediaFile(file));
        }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, supported.length)) }, inspectWorker));

    const meta = await loadLibraryMeta(normalizedRoots);
    const sidecarPaths = new Set([
        ...meta.favorites,
        ...Object.keys(meta.tags),
        ...Object.keys(meta.ratings),
        ...Object.keys(meta.culling),
    ]);
    await Promise.all([...sidecarPaths].map(async filePath => {
        try {
            await fs.access(filePath);
        } catch {
            issues.push({ category: 'orphan-sidecar', path: filePath, detail: 'A sidecar favorite or tag points to a file that no longer exists.' });
        }
    }));

    issues.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
    const summary = emptySummary();
    for (const issue of issues) summary[issue.category]++;
    return { roots: normalizedRoots, scannedFiles: supported.length, issues, summary };
}

const toPortableRelative = (relativePath: string) => relativePath.split(path.sep).join('/');
const fromPortableRelative = (relativePath: string) => relativePath.replace(/\\/g, '/').split('/').join(path.sep);

function isSafeRelative(relativePath: string): boolean {
    const normalized = fromPortableRelative(relativePath);
    return normalized.length > 0 && !path.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

const quarantineRoot = (root: string) => path.join(root, QUARANTINE_DIR);
const manifestPath = (root: string) => path.join(quarantineRoot(root), QUARANTINE_MANIFEST);

async function readQuarantineManifest(root: string): Promise<QuarantineManifest> {
    try {
        const parsed = JSON.parse(await fs.readFile(manifestPath(root), 'utf8')) as Partial<QuarantineManifest>;
        const entries = Array.isArray(parsed.entries) ? parsed.entries.filter((entry): entry is QuarantineManifestEntry => (
            !!entry && typeof entry.original === 'string' && typeof entry.quarantined === 'string' &&
            typeof entry.quarantinedAt === 'string' && isSafeRelative(entry.original) && isSafeRelative(entry.quarantined)
        )) : [];
        return { version: 1, entries };
    } catch {
        return { version: 1, entries: [] };
    }
}

async function writeQuarantineManifest(root: string, manifest: QuarantineManifest): Promise<void> {
    const dir = quarantineRoot(root);
    await fs.mkdir(dir, { recursive: true });
    const target = manifestPath(root);
    const temporary = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8');
        await fs.rename(temporary, target);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

async function moveAcrossDevices(source: string, destination: string): Promise<void> {
    try {
        await fs.rename(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await fs.copyFile(source, destination);
        await fs.unlink(source);
    }
}

async function unusedDestination(requested: string): Promise<string> {
    const parsed = path.parse(requested);
    let candidate = requested;
    for (let suffix = 2; ; suffix++) {
        try {
            await fs.access(candidate);
            candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
        } catch {
            return candidate;
        }
    }
}

/** Move selected files into a hidden quarantine folder within their library root. */
export async function quarantineCorruptFiles(roots: string[], filePaths: string[]): Promise<QuarantinedFile[]> {
    const normalizedRoots = [...new Set(roots.map(root => path.resolve(root)))].sort((a, b) => b.length - a.length);
    const results: QuarantinedFile[] = [];
    for (const requested of [...new Set(filePaths)]) {
        const source = path.resolve(requested);
        const root = normalizedRoots.find(candidate => isWithin(candidate, source));
        if (!root || isWithin(quarantineRoot(root), source)) continue;
        let stat;
        try {
            stat = await fs.stat(source);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        const relative = path.relative(root, source);
        const destination = await unusedDestination(path.join(quarantineRoot(root), relative));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await moveAcrossDevices(source, destination);
        const manifest = await readQuarantineManifest(root);
        manifest.entries = manifest.entries.filter(entry => entry.quarantined !== toPortableRelative(path.relative(quarantineRoot(root), destination)));
        manifest.entries.push({
            original: toPortableRelative(relative),
            quarantined: toPortableRelative(path.relative(quarantineRoot(root), destination)),
            quarantinedAt: new Date().toISOString(),
        });
        await writeQuarantineManifest(root, manifest);
        results.push({ source, destination });
    }
    return results;
}

export async function listQuarantinedFiles(roots: string[]): Promise<QuarantineEntry[]> {
    const entries: QuarantineEntry[] = [];
    for (const root of [...new Set(roots.map(candidate => path.resolve(candidate)))]) {
        const dir = quarantineRoot(root);
        let files: string[];
        try {
            files = await glob('**/*', { cwd: dir.replace(/\\/g, '/'), absolute: true, onlyFiles: true, dot: false });
        } catch {
            continue;
        }
        const manifest = await readQuarantineManifest(root);
        const recorded = new Map(manifest.entries.map(entry => [entry.quarantined, entry]));
        for (const filePath of files) {
            const quarantinePath = path.normalize(filePath);
            const relative = toPortableRelative(path.relative(dir, quarantinePath));
            const saved = recorded.get(relative);
            const originalRelative = saved?.original ?? relative;
            if (!isSafeRelative(originalRelative)) continue;
            try {
                const stat = await fs.stat(quarantinePath);
                entries.push({
                    root,
                    originalPath: path.join(root, fromPortableRelative(originalRelative)),
                    quarantinePath,
                    size: stat.size,
                    quarantinedAt: saved?.quarantinedAt ?? null,
                });
            } catch {
                // It disappeared during the listing; leave it out.
            }
        }
    }
    return entries.sort((a, b) => (b.quarantinedAt ?? '').localeCompare(a.quarantinedAt ?? '') || a.originalPath.localeCompare(b.originalPath));
}

async function removeManifestEntries(root: string, quarantinePaths: Set<string>): Promise<void> {
    const manifest = await readQuarantineManifest(root);
    const dir = quarantineRoot(root);
    manifest.entries = manifest.entries.filter(entry => !quarantinePaths.has(path.join(dir, fromPortableRelative(entry.quarantined))));
    await writeQuarantineManifest(root, manifest);
}

export async function restoreQuarantinedFiles(roots: string[], requestedPaths: string[]): Promise<RestoredQuarantineFile[]> {
    const available = await listQuarantinedFiles(roots);
    const byPath = new Map(available.map(entry => [entry.quarantinePath, entry]));
    const restored: RestoredQuarantineFile[] = [];
    const removedByRoot = new Map<string, Set<string>>();
    for (const requested of [...new Set(requestedPaths.map(candidate => path.resolve(candidate)))]) {
        const entry = byPath.get(requested);
        if (!entry || !isWithin(quarantineRoot(entry.root), requested) || !isWithin(entry.root, entry.originalPath)) continue;
        const destination = await unusedDestination(entry.originalPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await moveAcrossDevices(requested, destination);
        if (!removedByRoot.has(entry.root)) removedByRoot.set(entry.root, new Set());
        removedByRoot.get(entry.root)!.add(requested);
        restored.push({ quarantinePath: requested, restoredPath: destination });
    }
    await Promise.all([...removedByRoot].map(([root, paths]) => removeManifestEntries(root, paths)));
    return restored;
}

export async function permanentlyDeleteQuarantinedFiles(roots: string[], requestedPaths: string[]): Promise<string[]> {
    const available = await listQuarantinedFiles(roots);
    const byPath = new Map(available.map(entry => [entry.quarantinePath, entry]));
    const deleted: string[] = [];
    const removedByRoot = new Map<string, Set<string>>();
    for (const requested of [...new Set(requestedPaths.map(candidate => path.resolve(candidate)))]) {
        const entry = byPath.get(requested);
        if (!entry || !isWithin(quarantineRoot(entry.root), requested)) continue;
        try {
            await fs.unlink(requested);
            if (!removedByRoot.has(entry.root)) removedByRoot.set(entry.root, new Set());
            removedByRoot.get(entry.root)!.add(requested);
            deleted.push(requested);
        } catch {
            // Missing/unreadable items are reported by omission.
        }
    }
    await Promise.all([...removedByRoot].map(([root, paths]) => removeManifestEntries(root, paths)));
    return deleted;
}

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

export function healthReportToCsv(report: LibraryHealthReport): string {
    const lines = [
        ['category', 'path', 'detail'].map(csvCell).join(','),
        ...report.issues.map(issue => [issue.category, issue.path, issue.detail].map(csvCell).join(',')),
    ];
    return `${lines.join('\n')}\n`;
}

export function quarantineEntriesToCsv(entries: QuarantineEntry[]): string {
    const lines = [
        ['original_path', 'quarantine_path', 'size_bytes', 'quarantined_at'].map(csvCell).join(','),
        ...entries.map(entry => [entry.originalPath, entry.quarantinePath, entry.size, entry.quarantinedAt ?? ''].map(csvCell).join(',')),
    ];
    return `${lines.join('\n')}\n`;
}

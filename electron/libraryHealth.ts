import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'fast-glob';
import sharp from 'sharp';
import { inspectHeifStructure } from './heifStructure';
import { inspectVideoStructure } from './videoStructure';
import { inspectMatroskaStructure } from './matroskaStructure';
import { decodeHeicImage } from './lazyDeps';
import ExifReader from 'exifreader';
import { loadLibraryMeta } from './libraryMeta';
import { isWithin } from './pathAccess';
import { scanDirectory } from './fileScanner';
import { type DeepVerifyCache, fileStamp } from './deepVerifyCache';

export type LibraryHealthCategory = 'corrupt' | 'tiny' | 'unsupported' | 'missing-date' | 'orphan-sidecar';

export interface LibraryHealthIssue {
    category: LibraryHealthCategory;
    path: string;
    detail: string;
}

export interface LibraryHealthOptions {
    /**
     * Decode every photo's pixels rather than trusting its header. Slow by
     * design — see `decodePixels` for what it buys.
     */
    deep?: boolean;
    /**
     * Called as files are inspected, throttled. A deep scan of a real
     * library runs for minutes, and a spinner that says nothing for that
     * long is indistinguishable from a hang.
     */
    onProgress?: (done: number, total: number) => void;
    /**
     * Asked between files. A scan the user has decided against should stop
     * costing them, and the one that can run for half an hour is exactly the
     * one they will change their mind about.
     */
    isCancelled?: () => boolean;
    /**
     * Decodes this scan may skip because a previous one already did them.
     * Only ever supplied for a deep scan — a shallow scan decodes nothing,
     * so letting it record "this file is fine" would make the next deep scan
     * skip the one thing it was asked to do. `scanLibraryHealth` refuses it
     * outright when `deep` is false rather than trusting its callers.
     */
    verified?: DeepVerifyCache;
}

export interface LibraryHealthReport {
    roots: string[];
    scannedFiles: number;
    /** Whether a deep scan produced this report; reports are not comparable across the two. */
    deep: boolean;
    /** Set when the user stopped the scan: the issues below are whatever had been found. */
    cancelled: boolean;
    /**
     * Photos whose pixels a previous deep scan had already decoded. A resumed
     * scan finishing in seconds is otherwise indistinguishable from one that
     * did not run.
     */
    skippedVerified: number;
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

/**
 * Formats the slideshow will not open at all. Kept in step with
 * `SUPPORTED_EXTENSIONS` by hand — `.mov` and `.mkv` moved out of this list
 * when they were shown to play, and a format can only ever be in one of them.
 */
const UNSUPPORTED_MEDIA_EXTENSIONS = new Set([
    '.avif', '.jfif', '.jxl', '.svg', '.tif', '.tiff',
    '.3gp', '.avi', '.m2ts', '.m4v', '.mts', '.wmv',
    '.cr2', '.cr3', '.dng', '.nef', '.orf', '.raf', '.raw', '.rw2',
]);

/** Video containers that are ISO base media format, so the box tree can be read. */
const ISO_BMFF_VIDEO = new Set(['.mp4', '.mov', '.gifv']);
/** Matroska and WebM: a different container, read by `matroskaStructure.ts`. */
const EBML_VIDEO = new Set(['.webm', '.mkv']);

const byCategoryThenPath = (a: LibraryHealthIssue, b: LibraryHealthIssue) =>
    a.category.localeCompare(b.category) || a.path.localeCompare(b.path);

const tally = (issues: LibraryHealthIssue[]): Record<LibraryHealthCategory, number> => {
    const summary = emptySummary();
    for (const issue of issues) summary[issue.category]++;
    return summary;
};

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
    // .mov is ISO base media format like .mp4 — iPhones and ffmpeg both write
    // an `ftyp` box with the brand `qt  `, so the same check covers it.
    if (ext === '.mp4' || ext === '.gifv' || ext === '.mov') {
        return header.length >= 12 && header.subarray(4, 12).includes(Buffer.from('ftyp'));
    }
    // Matroska and WebM share the EBML magic; .mkv is the general case of it.
    if (ext === '.webm' || ext === '.mkv') {
        return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    }
    if (ext === '.ogg') return header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'OggS';
    return false;
}

/**
 * Forces a real decode of every byte of pixel data, which is the only thing
 * that can see rot behind a valid header.
 *
 * The shallow scan reads headers, and a header is not evidence about the
 * image: `sharp().metadata()` reports 2000x1500 for a JPEG with 60% of its
 * scan data missing, and `heifStructure` reports a HEIC with a scribbled
 * `mdat` as intact. Both measured. Decoding catches those — of four
 * byte-level corruptions injected into a real HEIC's payload, libde265
 * rejected three.
 *
 * It is still not a proof of health: the fourth (twenty bytes near the end
 * of the payload) decoded without complaint, and a JPEG with 400 scribbled
 * bytes mid-scan decoded too. There is no cheap check that is also total,
 * which is why this is a deliberate choice and not the default.
 *
 * The resize is what keeps it affordable in memory: libvips reads
 * sequentially and never holds the full-resolution bitmap, so a 48MP photo
 * does not cost 200MB to verify. sharp's default `failOn: 'warning'` is what
 * turns libjpeg's complaints into a thrown error rather than a shrug.
 */
async function decodePixels(filePath: string, isHeif: boolean): Promise<boolean> {
    try {
        if (isHeif) {
            await decodeHeicImage(await fs.readFile(filePath));
        } else {
            await sharp(filePath, { animated: true }).resize({ width: 1 }).toBuffer();
        }
        return true;
    } catch {
        return false;
    }
}

async function inspectMediaFile(
    file: { path: string; type: 'image' | 'video' },
    deep: boolean,
    verified?: DeepVerifyCache,
): Promise<LibraryHealthIssue[]> {
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
                return [{ category: 'corrupt', path: file.path, detail: 'The video header is invalid or unreadable.' }];
            }
        } catch {
            return [{ category: 'corrupt', path: file.path, detail: 'The video could not be read.' }];
        }

        // The signature only says the file began life as a video. The
        // structure says whether all of it arrived — an mp4 truncated to 30%
        // of its bytes passed the signature check and was reported healthy,
        // and so did a truncated .webm until it got the same treatment. Two
        // readers because they are two containers: `videoStructure.ts` walks
        // ISO-BMFF boxes, `matroskaStructure.ts` walks EBML elements.
        const structure = ISO_BMFF_VIDEO.has(ext)
            ? await inspectVideoStructure(file.path, stat.size)
            : EBML_VIDEO.has(ext)
                ? await inspectMatroskaStructure(file.path, stat.size)
                : null;
        if (structure?.kind === 'damaged') {
            issues.push({ category: 'corrupt', path: file.path, detail: structure.detail });
        }
        return issues;
    }

    const isHeif = ext === '.heic' || ext === '.heif';
    let width = 0;
    let height = 0;

    if (isHeif) {
        // Reading the box tree beats decoding by ~60x a photo and still
        // catches the way a HEIC in someone's library actually goes bad; see
        // heifStructure.ts for what that does and does not promise. Anything
        // it cannot vouch for falls through to the decode below, which stays
        // the authority.
        const structure = await inspectHeifStructure(file.path, stat.size);
        if (structure.kind === 'damaged') {
            return [{ category: 'corrupt', path: file.path, detail: structure.detail }];
        }
        if (structure.kind === 'intact') {
            width = structure.width;
            height = structure.height;
        }
    }

    if (!width || !height) {
        try {
            if (isHeif) {
                const decoded = await decodeHeicImage(await fs.readFile(file.path));
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
    }

    // A HEIC whose boxes answered for it, or any other image whose header
    // did, has not actually been decoded yet. Only a deep scan pays for that
    // — and only once per file, so stopping a scan and restarting it does
    // not pay again (see deepVerifyCache.ts).
    if (deep) {
        const stamp = fileStamp(stat.size, stat.mtimeMs);
        const remembered = verified?.get(file.path, stamp);
        const decoded = remembered ?? await decodePixels(file.path, isHeif);
        if (remembered === undefined) verified?.set(file.path, stamp, decoded);
        if (!decoded) {
            return [{
                category: 'corrupt',
                path: file.path,
                detail: 'The header reads correctly but the image data could not be decoded.',
            }];
        }
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

export async function scanLibraryHealth(roots: string[], options: LibraryHealthOptions = {}): Promise<LibraryHealthReport> {
    const deep = options.deep === true;
    // The cache records that a file's pixels decoded. A shallow scan decodes
    // nothing, so it may neither read nor write it.
    const verified = deep ? options.verified : undefined;
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
    let done = 0;
    let cancelled = false;
    // Throttled rather than per-file: a 5,000-file library would otherwise
    // put 5,000 IPC messages behind a progress bar that redraws 60 times a
    // second at best.
    let lastReport = 0;
    const PROGRESS_INTERVAL_MS = 150;
    const report = (force: boolean) => {
        const now = Date.now();
        if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = now;
        options.onProgress?.(done, supported.length);
    };

    const inspectWorker = async () => {
        while (next < supported.length) {
            if (options.isCancelled?.()) { cancelled = true; return; }
            const file = supported[next++];
            issues.push(...await inspectMediaFile(file, deep, verified));
            done++;
            report(false);
        }
    };
    report(true);
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, supported.length)) }, inspectWorker));
    report(true);

    // A cancelled scan reports what it found and stops. The sidecar pass
    // below is skipped too: it would walk the whole library's metadata for a
    // result the user has already said they do not want.
    if (cancelled) {
        issues.sort(byCategoryThenPath);
        return {
            roots: normalizedRoots, scannedFiles: done, deep, cancelled: true,
            skippedVerified: verified?.hits ?? 0,
            issues, summary: tally(issues),
        };
    }

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

    issues.sort(byCategoryThenPath);
    return {
        roots: normalizedRoots, scannedFiles: supported.length, deep, cancelled: false,
        skippedVerified: verified?.hits ?? 0,
        issues, summary: tally(issues),
    };
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

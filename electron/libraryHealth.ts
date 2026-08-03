import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'fast-glob';
import sharp from 'sharp';
import decodeHeic from 'heic-decode';
import ExifReader from 'exifreader';
import { loadLibraryMeta } from './libraryMeta';
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
    const sidecarPaths = new Set([...meta.favorites, ...Object.keys(meta.tags)]);
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


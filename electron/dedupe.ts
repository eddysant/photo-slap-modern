import glob from 'fast-glob';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface DedupeFile {
    path: string;
    size: number;
}

export interface DuplicateGroup {
    hash: string;
    files: string[];
}

const IMAGE_PATTERNS = ['**/*.jpg', '**/*.jpeg', '**/*.png', '**/*.webp', '**/*.gif', '**/*.heic', '**/*.heif'];
const VIDEO_PATTERNS = ['**/*.mp4', '**/*.mov', '**/*.webm', '**/*.mkv', '**/*.ogg', '**/*.gifv'];

const asDirs = (dirs: string | string[]) => (Array.isArray(dirs) ? dirs : [dirs]);

/**
 * fast-glob matches case-sensitively by default, so the lowercase patterns
 * above missed every IMG_0001.JPG / CLIP.MOV a camera or phone produces —
 * the duplicate finder silently ignored them while the slideshow (which
 * lowercases the extension before matching) showed them. Keep this in step
 * with fileScanner.ts.
 */
const GLOB_OPTIONS = { absolute: true, onlyFiles: true, caseSensitiveMatch: false } as const;

/** Hashing reads whole files; a few at once keeps the disk busy without thrashing. */
const HASH_CONCURRENCY = 8;

export async function scanFiles(dirs: string | string[], kind: 'images' | 'videos' = 'images'): Promise<string[]> {
    const patterns = kind === 'videos' ? VIDEO_PATTERNS : IMAGE_PATTERNS;

    const results = await Promise.all(asDirs(dirs).map(dir => glob(patterns, {
        cwd: path.resolve(dir).replace(/\\/g, '/'),
        ...GLOB_OPTIONS,
    })));

    return [...new Set(results.flat())];
}

export async function findExactDuplicates(dirs: string | string[], includeVideos = true): Promise<DuplicateGroup[]> {
    const patterns = includeVideos ? [...IMAGE_PATTERNS, ...VIDEO_PATTERNS] : IMAGE_PATTERNS;

    // Scan every folder into one pool so duplicates ACROSS folders group too
    const perDir = await Promise.all(asDirs(dirs).map(dir => glob(patterns, {
        cwd: path.resolve(dir).replace(/\\/g, '/'),
        ...GLOB_OPTIONS,
        stats: true,
        objectMode: true,
    })));
    const seen = new Set<string>();
    const entries = perDir.flat().filter(e => !seen.has(e.path) && seen.add(e.path));

    // Group by size
    const sizeMap = new Map<number, string[]>();
    for (const entry of entries) {
        const size = entry.stats?.size || 0;
        if (size === 0) continue;

        if (!sizeMap.has(size)) sizeMap.set(size, []);
        sizeMap.get(size)?.push(entry.path);
    }

    // Filter candidates
    const candidates: string[] = [];
    for (const paths of sizeMap.values()) {
        if (paths.length > 1) candidates.push(...paths);
    }

    // Hash candidates. Each hash reads a whole file, so they run a few at a
    // time instead of strictly one after another — on a library with many
    // same-sized candidates the sequential version was the whole scan's cost.
    const hashMap = new Map<string, string[]>();
    let next = 0;
    const worker = async () => {
        while (next < candidates.length) {
            const filePath = candidates[next++];
            try {
                const hash = await calculateHash(filePath);
                const group = hashMap.get(hash);
                if (group) group.push(filePath);
                else hashMap.set(hash, [filePath]);
            } catch (e) {
                console.error(`Failed to hash ${filePath}`, e);
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(HASH_CONCURRENCY, candidates.length) }, worker),
    );

    // Result. Files are sorted within each group and groups by their first
    // file: hashing now completes out of order, and the review UI compares
    // "the group's first two files", which should not shuffle between scans.
    const results: DuplicateGroup[] = [];
    for (const [hash, files] of hashMap.entries()) {
        if (files.length > 1) {
            results.push({ hash, files: [...files].sort() });
        }
    }
    results.sort((a, b) => a.files[0].localeCompare(b.files[0]));

    return results;
}

function calculateHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

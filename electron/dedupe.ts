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

export async function scanFiles(dir: string, kind: 'images' | 'videos' = 'images'): Promise<string[]> {
    const searchPath = path.resolve(dir).replace(/\\/g, '/');
    const patterns = kind === 'videos' ? VIDEO_PATTERNS : IMAGE_PATTERNS;

    const entries = await glob(patterns, {
        cwd: searchPath,
        absolute: true,
        onlyFiles: true
    });

    return entries;
}

export async function findExactDuplicates(dir: string, includeVideos = true): Promise<DuplicateGroup[]> {
    const searchPath = path.resolve(dir).replace(/\\/g, '/');
    const patterns = includeVideos ? [...IMAGE_PATTERNS, ...VIDEO_PATTERNS] : IMAGE_PATTERNS;

    const entries = await glob(patterns, {
        cwd: searchPath,
        absolute: true,
        stats: true,
        onlyFiles: true,
        objectMode: true
    });

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

    // Hash candidates
    const hashMap = new Map<string, string[]>();

    for (const filePath of candidates) {
        try {
            const hash = await calculateHash(filePath);
            if (!hashMap.has(hash)) hashMap.set(hash, []);
            hashMap.get(hash)?.push(filePath);
        } catch (e) {
            console.error(`Failed to hash ${filePath}`, e);
        }
    }

    // Result
    const results: DuplicateGroup[] = [];
    for (const [hash, files] of hashMap.entries()) {
        if (files.length > 1) {
            results.push({ hash, files });
        }
    }

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

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

export async function scanFiles(dir: string): Promise<string[]> {
    const searchPath = path.resolve(dir).replace(/\\/g, '/');
    const patterns = ['**/*.jpg', '**/*.jpeg', '**/*.png', '**/*.webp', '**/*.gif'];

    const entries = await glob(patterns, {
        cwd: searchPath,
        absolute: true,
        onlyFiles: true
    });

    return entries;
}

export async function findExactDuplicates(dir: string): Promise<DuplicateGroup[]> {
    const searchPath = path.resolve(dir).replace(/\\/g, '/');
    // Include videos for exact dedupe? Yes.
    const patterns = [
        '**/*.jpg', '**/*.jpeg', '**/*.png', '**/*.webp', '**/*.gif',
        '**/*.mp4', '**/*.mov', '**/*.webm', '**/*.mkv'
    ];

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

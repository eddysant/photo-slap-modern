import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanDirectory } from '../electron/fileScanner';

let dir: string;

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-scan-'));
    await fs.writeFile(path.join(dir, 'photo.jpg'), 'x');
    await fs.writeFile(path.join(dir, 'photo.HEIC'), 'x'); // uppercase ext
    await fs.writeFile(path.join(dir, 'clip.mp4'), 'x');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x'); // unsupported
    await fs.writeFile(path.join(dir, '.hidden.jpg'), 'x'); // dotfile
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, 'nested', 'deep.png'), 'x');
    await fs.mkdir(path.join(dir, '.git'));
    await fs.writeFile(path.join(dir, '.git', 'sneaky.jpg'), 'x'); // dot-dir
});

afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('scanDirectory', () => {
    it('finds supported media recursively, skipping dotfiles and dot-dirs', async () => {
        const { files, errors } = await scanDirectory(dir);
        const names = files.map(f => f.name).sort();
        expect(names).toEqual(['clip.mp4', 'deep.png', 'photo.HEIC', 'photo.jpg']);
        expect(errors).toEqual([]);
    });

    it('classifies images and videos', async () => {
        const { files } = await scanDirectory(dir);
        const byName = Object.fromEntries(files.map(f => [f.name, f.type]));
        expect(byName['photo.jpg']).toBe('image');
        expect(byName['photo.HEIC']).toBe('image');
        expect(byName['clip.mp4']).toBe('video');
    });

    it('reports unreadable directories in errors and still returns the rest', async () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod ineffective
        const locked = path.join(dir, 'locked');
        await fs.mkdir(locked, { recursive: true });
        await fs.chmod(locked, 0o000);
        try {
            const { files, errors } = await scanDirectory(dir);
            expect(errors.length).toBe(1);
            expect(errors[0]).toContain('locked');
            expect(files.length).toBeGreaterThan(0);
        } finally {
            await fs.chmod(locked, 0o755);
            await fs.rm(locked, { recursive: true, force: true });
        }
    });
});

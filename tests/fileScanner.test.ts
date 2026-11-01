import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanDirectory, SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS } from '../electron/fileScanner';

let dir: string;
let outside: string;

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

    // Symlinks pointing out of the library. pathAccess refuses to serve
    // anything reached through one, which is only safe because the scanner
    // never offers such a file in the first place — pin that here.
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-outside-'));
    await fs.writeFile(path.join(outside, 'secret.jpg'), 'x');
    await fs.symlink(path.join(outside, 'secret.jpg'), path.join(dir, 'linked.jpg'));
    await fs.symlink(outside, path.join(dir, 'elsewhere'));
});

afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
});

describe('scanDirectory', () => {
    it('finds supported media recursively, skipping dotfiles and dot-dirs', async () => {
        const { files, errors } = await scanDirectory(dir);
        const names = files.map(f => f.name).sort();
        expect(names).toEqual(['clip.mp4', 'deep.png', 'photo.HEIC', 'photo.jpg']);
        expect(errors).toEqual([]);
    });

    it('does not follow symlinks, so nothing outside the folder is offered', async () => {
        const { files } = await scanDirectory(dir);
        expect(files.map(f => f.name)).not.toContain('linked.jpg');
        expect(files.map(f => f.path).some(p => p.includes('elsewhere'))).toBe(false);
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

/**
 * `.mov` and `.mkv` were excluded on the strength of `canPlayType`, which
 * reports "no" for `video/quicktime`. Measured against Electron 43 serving
 * the file over a privileged scheme with that exact Content-Type — the
 * conditions media:// serves under — H.264 .mov, HEVC .mov and H.264 .mkv
 * all decoded and played. An iPhone shares .mov, so this is the format the
 * exclusion cost most.
 */
describe('the phone video formats', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-mov-'));
        // ISO base media format with the QuickTime brand, exactly as iPhones
        // and ffmpeg write it.
        const ftyp = Buffer.concat([
            Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftyp'), Buffer.from('qt  '),
            Buffer.alloc(8),
        ]);
        await fs.writeFile(path.join(dir, 'IMG_0001.mov'), Buffer.concat([ftyp, Buffer.alloc(64)]));
        // Matroska shares WebM's EBML magic.
        await fs.writeFile(path.join(dir, 'clip.mkv'),
            Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]));
        await fs.writeFile(path.join(dir, 'ignored.avi'), Buffer.alloc(64));
    });

    afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    it('offers them to the slideshow as video', async () => {
        const { files } = await scanDirectory(dir);
        const byName = Object.fromEntries(files.map(f => [f.name, f.type]));
        expect(byName['IMG_0001.mov']).toBe('video');
        expect(byName['clip.mkv']).toBe('video');
    });

    it('still ignores the formats that genuinely will not play', async () => {
        const { files } = await scanDirectory(dir);
        expect(files.map(f => f.name)).not.toContain('ignored.avi');
    });

    it('counts them as video, not as images', () => {
        expect(VIDEO_EXTENSIONS.has('.mov')).toBe(true);
        expect(VIDEO_EXTENSIONS.has('.mkv')).toBe(true);
        expect(SUPPORTED_EXTENSIONS.has('.mov')).toBe(true);
    });
});

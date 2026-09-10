import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findExactDuplicates, scanFiles } from '../electron/dedupe';

let dir: string;

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-dedupe-'));
    await fs.writeFile(path.join(dir, 'one.jpg'), 'identical-bytes');
    await fs.writeFile(path.join(dir, 'two.jpg'), 'identical-bytes');
    await fs.writeFile(path.join(dir, 'other.jpg'), 'different-bytes!'); // same size, different content
    await fs.writeFile(path.join(dir, 'small.png'), 'tiny');
});

afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('findExactDuplicates', () => {
    it('groups files with identical content only', async () => {
        const groups = await findExactDuplicates(dir);
        expect(groups).toHaveLength(1);
        expect(groups[0].files.map(f => path.basename(f)).sort()).toEqual(['one.jpg', 'two.jpg']);
    });
});

describe('scanFiles', () => {
    it('lists image files for perceptual hashing', async () => {
        const files = await scanFiles(dir);
        const names = files.map(f => path.basename(f)).sort();
        expect(names).toEqual(['one.jpg', 'other.jpg', 'small.png', 'two.jpg']);
    });
});

describe('uppercase extensions', () => {
    let upperDir: string;

    beforeAll(async () => {
        upperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-upper-'));
        // Cameras and phones routinely write uppercase extensions (IMG_0001.JPG).
        // The slideshow scanner lowercases before matching, so these files show
        // up in the show — the duplicate finder must not silently ignore them.
        await fs.writeFile(path.join(upperDir, 'IMG_0001.JPG'), 'same-bytes-here');
        await fs.writeFile(path.join(upperDir, 'IMG_0002.JPG'), 'same-bytes-here');
        await fs.writeFile(path.join(upperDir, 'CLIP.MOV'), 'video-bytes-aaaa');
        await fs.writeFile(path.join(upperDir, 'copy.MOV'), 'video-bytes-aaaa');
    });

    afterAll(async () => {
        await fs.rm(upperDir, { recursive: true, force: true });
    });

    it('scanFiles finds uppercase image extensions', async () => {
        const names = (await scanFiles(upperDir)).map(f => path.basename(f)).sort();
        expect(names).toEqual(['IMG_0001.JPG', 'IMG_0002.JPG']);
    });

    it('scanFiles finds uppercase video extensions', async () => {
        const names = (await scanFiles(upperDir, 'videos')).map(f => path.basename(f)).sort();
        expect(names).toEqual(['CLIP.MOV', 'copy.MOV']);
    });

    it('findExactDuplicates groups uppercase-extension duplicates', async () => {
        const groups = await findExactDuplicates(upperDir);
        const grouped = groups.map(g => g.files.map(f => path.basename(f)).sort()).sort();
        expect(grouped).toEqual([['CLIP.MOV', 'copy.MOV'], ['IMG_0001.JPG', 'IMG_0002.JPG']]);
    });
});

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

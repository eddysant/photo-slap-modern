import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { scanLibraryHealth } from '../electron/libraryHealth';
import { SIDECAR_NAME } from '../electron/libraryMeta';

describe('library health scan', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-health-'));
        await sharp({ create: { width: 100, height: 80, channels: 3, background: '#336699' } })
            .png().toFile(path.join(root, 'tiny.png'));
        await fs.writeFile(path.join(root, 'broken.jpg'), 'not an image');
        await fs.writeFile(path.join(root, 'legacy.mov'), 'unsupported video');
        await fs.writeFile(path.join(root, SIDECAR_NAME), JSON.stringify({
            version: 1,
            favorites: ['gone.jpg'],
            tags: { 'also-gone.jpg': ['missing'] },
            tagNames: ['missing'],
        }));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('finds corrupt, tiny, unsupported, undated, and orphaned entries', async () => {
        const report = await scanLibraryHealth([root]);
        expect(report.scannedFiles).toBe(2);
        expect(report.issues.some(i => i.category === 'corrupt' && i.path.endsWith('broken.jpg'))).toBe(true);
        expect(report.issues.some(i => i.category === 'tiny' && i.path.endsWith('tiny.png'))).toBe(true);
        expect(report.issues.some(i => i.category === 'unsupported' && i.path.endsWith('legacy.mov'))).toBe(true);
        expect(report.issues.some(i => i.category === 'missing-date' && i.path.endsWith('tiny.png'))).toBe(true);
        expect(report.summary['orphan-sidecar']).toBe(2);
    });
});


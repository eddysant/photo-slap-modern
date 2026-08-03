import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { healthReportToCsv, quarantineCorruptFiles, scanLibraryHealth } from '../electron/libraryHealth';
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

    it('moves corrupt files into a hidden quarantine tree', async () => {
        const broken = path.join(root, 'broken.jpg');
        const result = await quarantineCorruptFiles([root], [broken]);
        expect(result).toHaveLength(1);
        expect(result[0].destination).toContain(`${path.sep}.photo-slap-quarantine${path.sep}`);
        await expect(fs.access(broken)).rejects.toThrow();
        await expect(fs.access(result[0].destination)).resolves.toBeUndefined();
    });

    it('exports a CSV with safely quoted cells', () => {
        const csv = healthReportToCsv({
            roots: ['/lib'], scannedFiles: 1,
            issues: [{ category: 'corrupt', path: '/lib/a,b.jpg', detail: 'Could not read "header"' }],
            summary: { corrupt: 1, tiny: 0, unsupported: 0, 'missing-date': 0, 'orphan-sidecar': 0 },
        });
        expect(csv).toContain('"/lib/a,b.jpg"');
        expect(csv).toContain('"Could not read ""header"""');
    });
});

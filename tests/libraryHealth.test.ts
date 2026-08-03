import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
    healthReportToCsv, listQuarantinedFiles, permanentlyDeleteQuarantinedFiles,
    quarantineCorruptFiles, quarantineEntriesToCsv, restoreQuarantinedFiles, scanLibraryHealth,
} from '../electron/libraryHealth';
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
        const entries = await listQuarantinedFiles([root]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ originalPath: broken, quarantinePath: result[0].destination });
        expect(entries[0].quarantinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('restores quarantined files without overwriting a collision and clears the manifest', async () => {
        const broken = path.join(root, 'broken.jpg');
        const [moved] = await quarantineCorruptFiles([root], [broken]);
        await fs.writeFile(broken, 'replacement that must survive');

        const restored = await restoreQuarantinedFiles([root], [moved.destination]);
        expect(restored).toEqual([{ quarantinePath: moved.destination, restoredPath: path.join(root, 'broken-2.jpg') }]);
        expect(await fs.readFile(broken, 'utf8')).toBe('replacement that must survive');
        expect(await fs.readFile(restored[0].restoredPath, 'utf8')).toBe('not an image');
        expect(await listQuarantinedFiles([root])).toEqual([]);
    });

    it('discovers quarantine files created before manifests were introduced', async () => {
        const legacy = path.join(root, '.photo-slap-quarantine', 'nested', 'old.jpg');
        await fs.mkdir(path.dirname(legacy), { recursive: true });
        await fs.writeFile(legacy, 'legacy quarantine contents');

        expect(await listQuarantinedFiles([root])).toEqual([expect.objectContaining({
            root,
            originalPath: path.join(root, 'nested', 'old.jpg'),
            quarantinePath: legacy,
            quarantinedAt: null,
        })]);
    });

    it('permanently deletes only known quarantined files', async () => {
        const broken = path.join(root, 'broken.jpg');
        const outside = path.join(root, 'tiny.png');
        const [moved] = await quarantineCorruptFiles([root], [broken]);
        expect(await permanentlyDeleteQuarantinedFiles([root], [moved.destination, outside])).toEqual([moved.destination]);
        await expect(fs.access(moved.destination)).rejects.toThrow();
        await expect(fs.access(outside)).resolves.toBeUndefined();
        expect(await listQuarantinedFiles([root])).toEqual([]);
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

    it('exports the quarantine manifest with recovery metadata', () => {
        const csv = quarantineEntriesToCsv([{
            root: '/lib', originalPath: '/lib/a,b.jpg', quarantinePath: '/lib/.photo-slap-quarantine/a,b.jpg',
            size: 42, quarantinedAt: '2026-08-03T12:00:00.000Z',
        }]);
        expect(csv).toContain('"original_path","quarantine_path","size_bytes","quarantined_at"');
        expect(csv).toContain('"/lib/a,b.jpg"');
        expect(csv).toContain('"42"');
    });
});

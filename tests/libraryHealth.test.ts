import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
    healthReportToCsv, listQuarantinedFiles, permanentlyDeleteQuarantinedFiles,
    quarantineCorruptFiles, quarantineEntriesToCsv, restoreQuarantinedFiles, scanLibraryHealth,
    type LibraryHealthReport,
} from '../electron/libraryHealth';
import { SIDECAR_NAME } from '../electron/libraryMeta';
import { box, ftyp, heicFile, mdat } from './heifFixture';

describe('library health scan', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-health-'));
        await sharp({ create: { width: 100, height: 80, channels: 3, background: '#336699' } })
            .png().toFile(path.join(root, 'tiny.png'));
        await fs.writeFile(path.join(root, 'broken.jpg'), 'not an image');
        await fs.writeFile(path.join(root, 'legacy.avi'), 'unsupported video');
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
        expect(report.issues.some(i => i.category === 'unsupported' && i.path.endsWith('legacy.avi'))).toBe(true);
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
            roots: ['/lib'], scannedFiles: 1, deep: false, cancelled: false,
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

/**
 * The scan used to run the WASM HEVC decoder over every HEIC in the library
 * purely to learn its dimensions — 1020ms a photo, half an hour on a 2,000
 * photo library. It reads the box tree instead. These fixtures are
 * structurally valid HEIFs whose pixel data is deliberately nonsense, so the
 * decoder would reject all of them: the verdicts below are only reachable
 * without one.
 */
describe('HEIC health without a decode', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-heic-health-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const place = async (name: string, bytes: Buffer) => {
        await fs.writeFile(path.join(root, name), bytes);
    };

    it('passes a well-formed HEIC without decoding its pixels', async () => {
        // Big enough to clear the 10 KB floor too, so the only thing the
        // assertions below can be reacting to is the dimensions.
        await place('photo.heic', heicFile({ data: mdat(32 * 1024) }));
        const report = await scanLibraryHealth([root]);
        expect(report.scannedFiles).toBe(1);
        expect(report.summary.corrupt).toBe(0);
        // Read from `ispe`: a thumbnail-sized answer would have landed here.
        expect(report.summary.tiny).toBe(0);
    });

    it('reports a truncated HEIC as corrupt, and says why', async () => {
        const whole = heicFile({ data: mdat(32 * 1024) });
        await place('cut.heic', whole.subarray(0, whole.length - 512));
        const report = await scanLibraryHealth([root]);
        const issue = report.issues.find(i => i.category === 'corrupt');
        expect(issue?.path.endsWith('cut.heic')).toBe(true);
        expect(issue?.detail).toContain('truncated');
    });

    /**
     * A .heic that is not HEIF at all is not something the box reader may
     * judge, so the decoder still has the last word on it.
     */
    it('still falls back to the decoder for a file it cannot parse', async () => {
        await place('garbage.heic', Buffer.from('this is not a photo'));
        const report = await scanLibraryHealth([root]);
        expect(report.issues.some(i => i.category === 'corrupt' && i.path.endsWith('garbage.heic'))).toBe(true);
    });
});

/**
 * The deep scan decodes pixels instead of trusting headers. The two cases
 * below are the reason it exists, and both were verified against real files
 * before being written as tests: `sharp().metadata()` reports correct
 * dimensions for a JPEG missing more than half its scan data, and the box
 * reader calls a HEIC with a scribbled `mdat` intact.
 */
describe('deep library health scan', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-deep-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const corruptPaths = (report: LibraryHealthReport) =>
        report.issues.filter(i => i.category === 'corrupt').map(i => path.basename(i.path));

    /** Large enough that the 320px / 10KB "tiny" rule cannot be what fires. */
    const photo = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#b43f2a' } })
        .jpeg({ quality: 92 }).toBuffer();

    it('says which kind of scan produced the report', async () => {
        expect((await scanLibraryHealth([root])).deep).toBe(false);
        expect((await scanLibraryHealth([root], { deep: true })).deep).toBe(true);
    });

    it('catches a truncated photo that the header check passes', async () => {
        const whole = await photo();
        await fs.writeFile(path.join(root, 'cut.jpg'), whole.subarray(0, Math.floor(whole.length * 0.4)));

        // The shallow scan reads 1600x1200 out of the surviving header and
        // finds nothing wrong at all.
        expect(corruptPaths(await scanLibraryHealth([root]))).toEqual([]);

        const deep = await scanLibraryHealth([root], { deep: true });
        expect(corruptPaths(deep)).toEqual(['cut.jpg']);
        expect(deep.issues.find(i => i.category === 'corrupt')?.detail).toContain('header reads correctly');
    });

    it('catches a HEIC whose boxes are intact and whose pixels are not', async () => {
        // heifFixture builds a valid box tree over deliberately meaningless
        // payload bytes — exactly the gap the structural check cannot see.
        await fs.writeFile(path.join(root, 'rotten.heic'), heicFile({ data: mdat(32 * 1024) }));

        expect(corruptPaths(await scanLibraryHealth([root]))).toEqual([]);
        expect(corruptPaths(await scanLibraryHealth([root], { deep: true }))).toEqual(['rotten.heic']);
    });

    it('does not accuse a healthy photo', async () => {
        await fs.writeFile(path.join(root, 'fine.jpg'), await photo());
        const deep = await scanLibraryHealth([root], { deep: true });
        expect(corruptPaths(deep)).toEqual([]);
        expect(deep.scannedFiles).toBe(1);
    });

    /**
     * A structurally broken HEIC should keep the specific diagnosis the box
     * reader gave it, not be flattened into the generic decode failure — the
     * truncation message is the one that tells the user what happened.
     */
    it('keeps the structural diagnosis when a deep scan is asked for', async () => {
        const whole = heicFile({ data: mdat(32 * 1024) });
        await fs.writeFile(path.join(root, 'short.heic'), whole.subarray(0, whole.length - 512));
        const deep = await scanLibraryHealth([root], { deep: true });
        expect(deep.issues.find(i => i.category === 'corrupt')?.detail).toContain('truncated');
    });
});

describe('watching, and stopping, a long scan', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-progress-'));
        // Twelve ordinary photos; what they contain does not matter here.
        await Promise.all(Array.from({ length: 12 }, async (_, i) => {
            const bytes = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#2a6fb4' } })
                .jpeg({ quality: 90 }).toBuffer();
            await fs.writeFile(path.join(root, `p${i}.jpg`), bytes);
        }));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('reports progress against a total it knows up front', async () => {
        const seen: { done: number; total: number }[] = [];
        const report = await scanLibraryHealth([root], { onProgress: (done, total) => seen.push({ done, total }) });

        expect(seen.length).toBeGreaterThan(0);
        // A progress bar is only honest if the total does not move under it.
        expect(new Set(seen.map(p => p.total))).toEqual(new Set([12]));
        expect(seen.map(p => p.done)).toEqual([...seen.map(p => p.done)].sort((a, b) => a - b));
        // Whatever the throttle dropped, the last report is the finished count.
        expect(seen[seen.length - 1]).toEqual({ done: 12, total: 12 });
        expect(report.scannedFiles).toBe(12);
        expect(report.cancelled).toBe(false);
    });

    /**
     * Cancelling has to stop the work, not just hide it: a deep scan of a
     * large library is minutes of decoding, which is the whole reason the
     * button exists.
     */
    it('stops early when asked and says the report is partial', async () => {
        // Asked between files, so counting the asks counts the files: the
        // throttled progress callback is too coarse to cancel against on a
        // library this small, and that is a property of the throttle rather
        // than of the cancel.
        let asked = 0;
        const report = await scanLibraryHealth([root], { isCancelled: () => ++asked > 4 });

        expect(report.cancelled).toBe(true);
        expect(report.scannedFiles).toBeLessThan(12);
        expect(report.scannedFiles).toBeGreaterThan(0);
    });

    it('scans everything when the cancel check never fires', async () => {
        const report = await scanLibraryHealth([root], { isCancelled: () => false });
        expect(report).toMatchObject({ cancelled: false, scannedFiles: 12 });
    });
});

/**
 * A video was checked by its first twelve bytes, so a download cut short —
 * which keeps its `ftyp` signature intact — was reported as healthy by both
 * scans. The box walk is what sees the difference, and it costs no decode.
 */
describe('video health', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-vhealth-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const mp4 = (payload = 8192) => Buffer.concat([
        ftyp('isom', ['mp42', 'avc1']),
        mdat(payload),
        box('moov', Buffer.alloc(512, 0x11)),
    ]);

    const corrupt = (report: LibraryHealthReport) =>
        report.issues.filter(i => i.category === 'corrupt').map(i => path.basename(i.path));

    it('leaves a well-formed video alone', async () => {
        await fs.writeFile(path.join(root, 'ok.mp4'), mp4());
        expect(corrupt(await scanLibraryHealth([root]))).toEqual([]);
    });

    it('catches a truncated video in the ordinary scan', async () => {
        const whole = mp4();
        await fs.writeFile(path.join(root, 'cut.mp4'), whole.subarray(0, Math.floor(whole.length * 0.3)));
        expect(corrupt(await scanLibraryHealth([root]))).toEqual(['cut.mp4']);
    });

    it('checks a .mov the same way, now that the show plays them', async () => {
        const whole = mp4();
        await fs.writeFile(path.join(root, 'cut.mov'), whole.subarray(0, whole.length - 1));
        await fs.writeFile(path.join(root, 'ok.mov'), mp4(4096));
        expect(corrupt(await scanLibraryHealth([root]))).toEqual(['cut.mov']);
    });

    /**
     * An EBML container gets only the magic-byte check — nothing here reads
     * its structure — so it must not be accused on the strength of that.
     */
    it('does not accuse a container it cannot read the structure of', async () => {
        const ebml = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40_000, 9)]);
        await fs.writeFile(path.join(root, 'clip.webm'), ebml);
        expect(corrupt(await scanLibraryHealth([root]))).toEqual([]);
    });
});

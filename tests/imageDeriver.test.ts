import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {
    createImageDeriver, createVariantIndex, parseVariantName, variantName, fileKeyFor,
    type ImageDeriver, type RawImage,
} from '../electron/imageDeriver';

/**
 * The decoder is a stand-in that counts. What these tests are about is *how
 * often the expensive step runs*, and the only way to observe that from
 * outside is to own the step: a real HEVC decode would make every assertion
 * here a timing guess.
 */
const WIDTH = 800, HEIGHT = 600;
function makeDecoder() {
    const state = { calls: 0, release: null as null | (() => void), hold: false };
    const decodeHeic = async (): Promise<RawImage> => {
        state.calls++;
        if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
        const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = (i / 4) % 256; data[i + 1] = 90; data[i + 2] = 160; data[i + 3] = 255;
        }
        return { width: WIDTH, height: HEIGHT, data };
    };
    return { state, decodeHeic };
}

const longest = async (buffer: Buffer) => {
    const { width, height } = await sharp(buffer).metadata();
    return Math.max(width ?? 0, height ?? 0);
};

let dir: string, cacheDir: string, heic: string;
let live: ImageDeriver[] = [];

function deriverWith(decodeHeic: () => Promise<RawImage>, extra: Partial<Parameters<typeof createImageDeriver>[0]> = {}) {
    const deriver = createImageDeriver({
        decodeHeic, concurrency: 3, maxBytes: 500 * 1024 * 1024, sweepIntervalBytes: 50 * 1024 * 1024, ...extra,
    });
    live.push(deriver);
    return deriver;
}

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-derive-'));
    cacheDir = path.join(dir, 'cache');
    await fs.mkdir(cacheDir);
    heic = path.join(dir, 'IMG_0001.HEIC');
    await fs.writeFile(heic, 'not really hevc — the decoder is injected');
    live = [];
});
afterEach(async () => {
    await Promise.all(live.map(d => d.idle()));
    await fs.rm(dir, { recursive: true, force: true });
});

describe('variant names', () => {
    it('round-trips the file key and the dimension', () => {
        const key = fileKeyFor('/a/b.heic', 1234.5, 99);
        expect(parseVariantName(variantName(key, 2560, 'jpg'))).toEqual({ fileKey: key, dim: 2560 });
        expect(parseVariantName(variantName(key, Infinity, 'jpg'))).toEqual({ fileKey: key, dim: Infinity });
    });

    it('declines anything that is not a variant', () => {
        const key = fileKeyFor('/a/b.heic', 1, 1);
        // a write still in flight, and an entry from before the dimension was in the name
        expect(parseVariantName(`${key}-256.jpg.4242-a1b2c3d4e5f6.tmp`)).toBeNull();
        expect(parseVariantName(`${key}.jpg`)).toBeNull();
        expect(parseVariantName('.DS_Store')).toBeNull();
    });

    it('a file edited in place is a different file', () => {
        expect(fileKeyFor('/a/b.heic', 1, 10)).not.toBe(fileKeyFor('/a/b.heic', 2, 10));
        expect(fileKeyFor('/a/b.heic', 1, 10)).not.toBe(fileKeyFor('/a/b.heic', 1, 11));
    });
});

describe('the variant index', () => {
    it('offers only larger variants, smallest first, the full transcode last', () => {
        const index = createVariantIndex();
        for (const dim of [64, 2560, Infinity, 512, 1024]) index.add('k', dim);
        expect(index.largerThan('k', 512)).toEqual([1024, 2560, Infinity]);
        expect(index.largerThan('k', 4096)).toEqual([Infinity]);
        expect(index.largerThan('other', 64)).toEqual([]);
    });

    it('forgets what is removed', () => {
        const index = createVariantIndex();
        index.add('k', 2560);
        index.remove('k', 2560);
        expect(index.largerThan('k', 64)).toEqual([]);
    });
});

describe('a HEIC is decoded once, not once per size', () => {
    it('cuts a smaller variant from a larger one already made', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);

        const slide = await deriver.derive(heic, 512);
        const thumb = await deriver.derive(heic, 256);
        const ambient = await deriver.derive(heic, 64);

        expect(state.calls).toBe(1);
        expect(await longest(slide.buffer)).toBe(512);
        expect(await longest(thumb.buffer)).toBe(256);
        expect(await longest(ambient.buffer)).toBe(64);
    });

    it('does so in the window before the larger one has reached the disk', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);

        await deriver.derive(heic, 512);
        // No idle(): the cache write for 512 has been started and not awaited.
        await deriver.derive(heic, 64);
        expect(state.calls).toBe(1);
    });

    it('never makes a larger variant out of a smaller one', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);

        await deriver.derive(heic, 64);
        const slide = await deriver.derive(heic, 512);

        // The stated limit: thumbnail first still costs the slide a decode.
        expect(state.calls).toBe(2);
        expect(await longest(slide.buffer)).toBe(512);
    });

    it('shares one decode between requests that overlap, whichever came first', async () => {
        for (const order of [[64, 512], [512, 64]]) {
            const { state, decodeHeic } = makeDecoder();
            const deriver = deriverWith(decodeHeic);
            await deriver.useCacheDir(cacheDir);
            const file = path.join(dir, `overlap-${order[0]}.heic`);
            await fs.writeFile(file, 'x');

            state.hold = true;
            const first = deriver.derive(file, order[0]);
            // Let the first reach the decoder and park there.
            while (state.calls === 0) await new Promise(r => setTimeout(r, 5));
            const second = deriver.derive(file, order[1]);
            await new Promise(r => setTimeout(r, 30));
            state.hold = false;
            state.release?.();

            const [a, b] = await Promise.all([first, second]);
            expect(state.calls).toBe(1);
            expect(await longest(a.buffer)).toBe(order[0]);
            expect(await longest(b.buffer)).toBe(order[1]);
        }
    });

    it('waits for a larger variant that is past its decode and still encoding', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);

        state.hold = true;
        const slide = deriver.derive(heic, 512);
        while (state.calls === 0) await new Promise(r => setTimeout(r, 5));
        state.hold = false;
        state.release?.();
        // The decode has settled and is no longer there to share; the 512 is
        // in sharp's hands and not yet a result. Neither the cache nor the
        // decode can answer, only the derive still in flight.
        await new Promise(r => setImmediate(r));
        const thumb = await deriver.derive(heic, 64);
        await slide;

        expect(state.calls).toBe(1);
        expect(await longest(thumb.buffer)).toBe(64);
    });

    it('coalesces identical requests', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);
        const [a, b] = await Promise.all([deriver.derive(heic, 256), deriver.derive(heic, 256)]);
        expect(state.calls).toBe(1);
        // The same object, not merely equal bytes: the shared decode alone
        // would keep the count at one while the resize and encode ran twice.
        expect(a.buffer).toBe(b.buffer);
    });

    it('finds the larger variant again after a restart', async () => {
        const first = makeDecoder();
        const before = deriverWith(first.decodeHeic);
        await before.useCacheDir(cacheDir);
        await before.derive(heic, 512);
        await before.idle();

        const second = makeDecoder();
        const after = deriverWith(second.decodeHeic);
        await after.useCacheDir(cacheDir); // the index comes from the directory listing
        const thumb = await after.derive(heic, 64);

        expect(second.state.calls).toBe(0);
        expect(await longest(thumb.buffer)).toBe(64);
    });

    it('decodes after all when the larger variant has gone from the disk', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);
        await deriver.derive(heic, 512);
        await deriver.idle();

        // Evicted behind the index's back; the index is a hint, not the authority.
        for (const name of await fs.readdir(cacheDir)) await fs.rm(path.join(cacheDir, name));
        const thumb = await deriver.derive(heic, 64);

        expect(state.calls).toBe(2);
        expect(await longest(thumb.buffer)).toBe(64);
    });

    it('does not reuse a variant of the file as it was before an edit', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);
        await deriver.derive(heic, 512);
        await deriver.idle();

        await fs.writeFile(heic, 'the same photo, re-saved and now a different length');
        await deriver.derive(heic, 64);
        expect(state.calls).toBe(2);
    });

    it('still works with no cache directory at all', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        const thumb = await deriver.derive(heic, 64);
        expect(await longest(thumb.buffer)).toBe(64);
        await deriver.derive(heic, 64);
        expect(state.calls).toBe(2); // nothing to remember it in
        expect(await fs.readdir(cacheDir)).toEqual([]);
    });
});

describe('everything that is not a HEIC', () => {
    let jpg: string;
    beforeEach(async () => {
        jpg = path.join(dir, 'photo.jpg');
        await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#336699' } }).jpeg().toFile(jpg);
    });

    it('is downscaled from the original and never touches the HEIC decoder', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic);
        await deriver.useCacheDir(cacheDir);
        const out = await deriver.derive(jpg, 300);
        expect(out.type).toBe('image/jpeg');
        expect(await longest(out.buffer)).toBe(300);
        expect(state.calls).toBe(0);
    });

    it('is served from the cache the second time, byte for byte', async () => {
        const deriver = deriverWith(makeDecoder().decodeHeic);
        await deriver.useCacheDir(cacheDir);
        const first = await deriver.derive(jpg, 300);
        await deriver.idle();
        // Remove the original: only the cache can answer now.
        const stat = await fs.stat(jpg);
        const key = fileKeyFor(jpg, stat.mtimeMs, stat.size);
        expect(await fs.readdir(cacheDir)).toEqual([variantName(key, 300, 'jpg')]);
        const second = await deriver.derive(jpg, 300);
        expect(Buffer.compare(first.buffer, second.buffer)).toBe(0);
    });

    it('keeps a PNG a PNG', async () => {
        const png = path.join(dir, 'alpha.png');
        await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(png);
        const deriver = deriverWith(makeDecoder().decodeHeic);
        await deriver.useCacheDir(cacheDir);
        const out = await deriver.derive(png, 100);
        expect(out.type).toBe('image/png');
        expect((await sharp(out.buffer).metadata()).format).toBe('png');
    });
});

describe('the LRU sweep', () => {
    it('evicts the least recently used first and the index forgets it', async () => {
        const { state, decodeHeic } = makeDecoder();
        const deriver = deriverWith(decodeHeic, { maxBytes: 1 }); // everything is over budget
        await deriver.useCacheDir(cacheDir);
        await deriver.derive(heic, 512);
        await deriver.idle();
        await deriver.sweep();
        expect(await fs.readdir(cacheDir)).toEqual([]);

        // The index must not still offer the evicted 512 as a source.
        await deriver.derive(heic, 64);
        expect(state.calls).toBe(2);
    });

    it('keeps what fits, dropping the oldest', async () => {
        const deriver = deriverWith(makeDecoder().decodeHeic);
        await deriver.useCacheDir(cacheDir);
        const old = path.join(cacheDir, variantName('a'.repeat(40), 64, 'jpg'));
        const recent = path.join(cacheDir, variantName('b'.repeat(40), 64, 'jpg'));
        await fs.writeFile(old, Buffer.alloc(600));
        await fs.writeFile(recent, Buffer.alloc(600));
        await fs.utimes(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

        const capped = deriverWith(makeDecoder().decodeHeic, { maxBytes: 1000 });
        await capped.useCacheDir(cacheDir); // sweeps on the way in
        expect(await fs.readdir(cacheDir)).toEqual([path.basename(recent)]);
    });

    it('is not abandoned because one entry vanished mid-sweep', async () => {
        // A dangling symlink lists but cannot be stat'd — the same shape as a
        // temp file renamed into place between the listing and the stat.
        await fs.symlink(path.join(cacheDir, 'gone'), path.join(cacheDir, 'vanishing.tmp'));
        await fs.writeFile(path.join(cacheDir, variantName('c'.repeat(40), 64, 'jpg')), Buffer.alloc(600));
        const deriver = deriverWith(makeDecoder().decodeHeic, { maxBytes: 1 });
        await deriver.useCacheDir(cacheDir);
        expect((await fs.readdir(cacheDir)).filter(n => n.endsWith('.jpg'))).toEqual([]);
    });
});

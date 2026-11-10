import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { createConcurrencyLimit } from './concurrencyLimit'
import { writeCacheEntry } from './imageCache'

/**
 * Derived images: HEIC transcodes and display-sized downscales, cached on
 * disk so each variant is computed once.
 *
 * This was a function in `main.ts`, where nothing could test it, and it had
 * one expensive habit: **every variant of a HEIC was made by decoding the
 * original again.** Chromium cannot decode HEVC and neither can prebuilt
 * sharp, so the decode is a WASM build of libheif running on the JS thread,
 * serialised to one at a time — and one iPhone photo is asked for at several
 * sizes: the slide, the 64px variant the ambient colour is averaged from, the
 * grid thumbnail, the 256px one a duplicate scan hashes, the 512px one the
 * phone remote shows. Each of those was a separate ~300ms decode of the same
 * file, queued behind everybody else's.
 *
 * Two rules remove the repeats, and neither changes what any request gets:
 *
 * - **A variant is made from a larger one when a larger one exists.** A 256px
 *   thumbnail of a photo whose 2560px slide is already cached is a 20ms
 *   resize of that JPEG instead of a decode of the original. Only ever
 *   downwards: a smaller variant is never a source for a larger one, so a
 *   thumbnail made first still costs the slide its own decode later. That
 *   case is deliberately left — closing it means encoding a full-size copy
 *   of every HEIC a grid scrolls past.
 * - **Requests for the same file that overlap share one decode**, in either
 *   order. The slide and its ambient colour are asked for within a frame of
 *   each other, and whichever arrived second used to queue a decode of its
 *   own behind the first.
 *
 * Knowing what is cached for a file needs the variants of one file to be
 * findable, which a hash of path+mtime+size+dimension — the old filename —
 * is not. The dimension is in the name now (`<file key>-<dim>.jpg`), and an
 * index of the directory is built once at startup from the same listing the
 * LRU sweep already reads. The index is a hint, never the authority: an
 * entry whose file has been evicted fails its read and falls through to the
 * decode, so it can go stale without anything being wrong.
 */

export interface RawImage {
    width: number;
    height: number;
    /** RGBA pixels. */
    data: ArrayBufferLike | ArrayBufferView;
}

export interface Derived {
    buffer: Buffer;
    type: string;
}

export interface ImageDeriverOptions {
    /** The HEVC decode — injected so tests can count how often it runs. */
    decodeHeic: (file: Buffer) => Promise<RawImage>;
    /** Simultaneous sharp pipelines; see `DERIVE_CONCURRENCY` in main. */
    concurrency: number;
    maxBytes: number;
    /** Bytes written between LRU sweeps. */
    sweepIntervalBytes: number;
}

const isHeic = (p: string) => /\.(heic|heif)$/i.test(p);

/** `Infinity` stands for the un-resized transcode, so it sorts as the largest. */
const FULL = Infinity;
const VARIANT_NAME = /^([0-9a-f]{40})-(full|\d+)\.(jpg|png)$/;

export function variantName(fileKey: string, dim: number, ext: 'jpg' | 'png'): string {
    return `${fileKey}-${dim === FULL ? 'full' : dim}.${ext}`;
}

/** Null for anything that is not a variant: a temp file mid-write, an entry from before the dimension was in the name. */
export function parseVariantName(name: string): { fileKey: string; dim: number } | null {
    const m = VARIANT_NAME.exec(name);
    if (!m) return null;
    return { fileKey: m[1], dim: m[2] === 'full' ? FULL : Number(m[2]) };
}

export function fileKeyFor(filePath: string, mtimeMs: number, size: number): string {
    return crypto.createHash('sha1').update(`${filePath}:${mtimeMs}:${size}`).digest('hex');
}

/** Which variants exist for which file. */
export function createVariantIndex() {
    const dims = new Map<string, Set<number>>();
    return {
        add(fileKey: string, dim: number) {
            let set = dims.get(fileKey);
            if (!set) dims.set(fileKey, set = new Set());
            set.add(dim);
        },
        remove(fileKey: string, dim: number) {
            const set = dims.get(fileKey);
            if (!set) return;
            set.delete(dim);
            if (set.size === 0) dims.delete(fileKey);
        },
        /**
         * Variants strictly larger than `wanted`, smallest first: the
         * smallest one that is still big enough is the cheapest to decode.
         */
        largerThan(fileKey: string, wanted: number): number[] {
            return [...(dims.get(fileKey) ?? [])].filter(d => d > wanted).sort((a, b) => a - b);
        },
    };
}

export function createImageDeriver(options: ImageDeriverOptions) {
    const withSlot = createConcurrencyLimit(options.concurrency);
    const index = createVariantIndex();
    let cacheDir: string | null = null;

    /** Derives in flight, per file and then per dimension, so identical requests coalesce and a smaller one can wait for a larger. */
    const inFlight = new Map<string, Map<number, Promise<Derived>>>();
    /** HEIC decodes in flight, so overlapping requests for one file share the pixels. */
    const decodes = new Map<string, Promise<RawImage>>();
    /**
     * Variants finished but not yet on disk. The write is not awaited — the
     * response should not wait for the filesystem — which left a window
     * where the variant was in neither place: a request landing in it
     * re-derived what had just been made. For a slide and the ambient colour
     * asked for straight after it, that window is where the second request
     * arrives.
     */
    const pendingWrites = new Map<string, Buffer>();
    const writes = new Set<Promise<void>>();

    let bytesSinceSweep = 0;
    let sweeping: Promise<void> | null = null;

    function noteWrite(bytes: number) {
        bytesSinceSweep += bytes;
        if (bytesSinceSweep < options.sweepIntervalBytes || sweeping) return;
        bytesSinceSweep = 0;
        sweeping = sweep().finally(() => { sweeping = null; });
    }

    /** LRU: hits touch mtime, so the oldest mtime is the least recently used. */
    async function sweep(): Promise<void> {
        const dir = cacheDir;
        if (!dir) return;
        try {
            const names = await fs.readdir(dir);
            const entries = (await Promise.all(names.map(async (name) => {
                try {
                    const stat = await fs.stat(path.join(dir, name));
                    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
                } catch {
                    // Gone between the listing and the stat — a temp file
                    // renamed into place does exactly this, and one of those
                    // used to abandon the whole sweep.
                    return null;
                }
            }))).filter(e => e !== null);
            let total = entries.reduce((sum, e) => sum + e.size, 0);
            if (total <= options.maxBytes) return;
            entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
            for (const entry of entries) {
                if (total <= options.maxBytes) break;
                await fs.unlink(path.join(dir, entry.name)).catch(() => { });
                const variant = parseVariantName(entry.name);
                if (variant) index.remove(variant.fileKey, variant.dim);
                total -= entry.size;
            }
        } catch {
            // best effort
        }
    }

    async function readVariant(fileKey: string, dim: number, ext: 'jpg' | 'png'): Promise<Buffer | null> {
        const name = variantName(fileKey, dim, ext);
        const pending = pendingWrites.get(name);
        if (pending) return pending;
        if (!cacheDir) return null;
        const file = path.join(cacheDir, name);
        try {
            const cached = await fs.readFile(file);
            fs.utimes(file, new Date(), new Date()).catch(() => { }); // LRU touch
            index.add(fileKey, dim);
            return cached;
        } catch {
            index.remove(fileKey, dim);
            return null;
        }
    }

    function remember(fileKey: string, dim: number, ext: 'jpg' | 'png', buffer: Buffer) {
        if (!cacheDir) return;
        const name = variantName(fileKey, dim, ext);
        pendingWrites.set(name, buffer);
        index.add(fileKey, dim);
        // Atomic, or a concurrent request for the same key reads a
        // half-written entry as a cache hit. See imageCache.ts.
        const write = writeCacheEntry(path.join(cacheDir, name), buffer)
            .then(() => noteWrite(buffer.length))
            .catch(() => index.remove(fileKey, dim))
            .finally(() => {
                pendingWrites.delete(name);
                writes.delete(write);
            });
        writes.add(write);
    }

    function sharedDecode(filePath: string): Promise<RawImage> {
        let decode = decodes.get(filePath);
        if (!decode) {
            decode = fs.readFile(filePath)
                .then(options.decodeHeic)
                .finally(() => decodes.delete(filePath));
            decodes.set(filePath, decode);
        }
        return decode;
    }

    /**
     * Something already made that a smaller HEIC variant can be cut from.
     * Runs before a derive slot is taken: it may wait on another derive, and
     * waiting inside a slot for a job that is itself queued for one is how
     * three thumbnails could have held every slot forever.
     */
    async function findSource(filePath: string, fileKey: string | null, wanted: number): Promise<Buffer | null> {
        if (fileKey) {
            for (const dim of index.largerThan(fileKey, wanted)) {
                const cached = await readVariant(fileKey, dim, 'jpg');
                if (cached) return cached;
            }
        }
        // The pixels are about to exist anyway; resizing them directly beats
        // waiting for someone else's JPEG and decoding that.
        if (decodes.has(filePath)) return null;
        const running = inFlight.get(filePath);
        if (running) {
            const larger = [...running.keys()].filter(d => d > wanted).sort((a, b) => a - b)[0];
            if (larger !== undefined) return running.get(larger)!.then(r => r.buffer, () => null);
        }
        return null;
    }

    async function run(
        filePath: string, maxDim: number | null, fileKey: string | null, asPng: boolean, type: string,
    ): Promise<Derived> {
        const heic = isHeic(filePath);
        const source = heic && maxDim ? await findSource(filePath, fileKey, maxDim) : null;

        return withSlot(async () => {
            let pipeline: ReturnType<typeof sharp>;
            if (source) {
                pipeline = sharp(source);
            } else if (heic) {
                const { width, height, data } = await sharedDecode(filePath);
                // `Buffer.from(typedArray)` copies: a second full-size RGBA
                // buffer — 48MB for a 12MP photo — on top of the one libheif
                // just handed over. A view over the same bytes costs nothing.
                const raw = ArrayBuffer.isView(data)
                    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                    : Buffer.from(data as ArrayBuffer);
                pipeline = sharp(raw, { raw: { width, height, channels: 4 } });
            } else {
                pipeline = sharp(filePath).rotate(); // bake EXIF orientation
            }
            if (maxDim) {
                pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
            }
            const buffer = asPng
                ? await pipeline.png().toBuffer()
                : await pipeline.jpeg({ quality: 90 }).toBuffer();

            if (fileKey) remember(fileKey, maxDim ?? FULL, asPng ? 'png' : 'jpg', buffer);
            return { buffer, type };
        });
    }

    /**
     * HEIC transcode and/or downscale to `maxDim` (longest side). Downscaling
     * exists because full-resolution camera photos (often 48MP) become ~200MB
     * GPU textures — several of those alive at once during a transition
     * causes texture thrash and visible artifacts.
     */
    async function derive(filePath: string, maxDim: number | null): Promise<Derived> {
        const asPng = /\.png$/i.test(filePath); // keep alpha for PNGs
        const type = asPng ? 'image/png' : 'image/jpeg';
        const dim = maxDim ?? FULL;

        let fileKey: string | null = null;
        if (cacheDir) {
            try {
                const stat = await fs.stat(filePath);
                fileKey = fileKeyFor(filePath, stat.mtimeMs, stat.size);
                const cached = await readVariant(fileKey, dim, asPng ? 'png' : 'jpg'); // no slot needed
                if (cached) return { buffer: cached, type };
            } catch {
                // unreadable — the derive below reports it
            }
        }

        let running = inFlight.get(filePath);
        const existing = running?.get(dim);
        if (existing) return existing;

        const job = run(filePath, maxDim, fileKey, asPng, type).finally(() => {
            const map = inFlight.get(filePath);
            if (!map) return;
            map.delete(dim);
            if (map.size === 0) inFlight.delete(filePath);
        });
        if (!running) inFlight.set(filePath, running = new Map());
        running.set(dim, job);
        return job;
    }

    /**
     * Point the deriver at its directory: index what is already there, then
     * sweep. Until this resolves the index is merely empty, which costs a
     * decode that a cached variant could have saved and nothing else.
     */
    async function useCacheDir(dir: string): Promise<void> {
        cacheDir = dir;
        try {
            for (const name of await fs.readdir(dir)) {
                const variant = parseVariantName(name);
                if (variant) index.add(variant.fileKey, variant.dim);
            }
        } catch {
            // an unreadable directory is an empty index
        }
        await sweep();
    }

    return {
        derive,
        useCacheDir,
        sweep,
        /** Resolves once every cache write started so far has landed. */
        async idle(): Promise<void> {
            while (writes.size > 0) await Promise.allSettled([...writes]);
            if (sweeping) await sweeping;
        },
    };
}

export type ImageDeriver = ReturnType<typeof createImageDeriver>;

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeCacheEntry } from '../electron/imageCache';

/**
 * A derived image is big enough that writing it takes several event-loop
 * turns, which is the whole reason the race exists. Camera-resolution
 * variants land in this range.
 */
const ENTRY = Buffer.alloc(4 * 1024 * 1024, 0x5a);
const ATTEMPTS = 40;

let dir: string;
/*
 * Writes deliberately left un-awaited by a test — the reader has to race
 * them. They are settled before the directory goes, or the teardown yanks
 * the destination out from under a rename still in flight.
 */
let pending: Promise<unknown>[] = [];
const racing = (p: Promise<unknown>) => { pending.push(p.catch(() => { })); };

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-cache-'));
    pending = [];
});
afterEach(async () => {
    await Promise.allSettled(pending);
    await fs.rm(dir, { recursive: true, force: true });
});

describe('derived-image cache writes', () => {
    /*
     * The baseline. `deriveImage`'s read side treats any successful read as a
     * cache hit, so a partial file is served as a complete image — a 200
     * carrying a truncated JPEG, which the renderer's `<img onError>` then
     * skips a healthy photo out of the slideshow over.
     *
     * This test is here so the one below cannot pass for the wrong reason: it
     * asserts the hazard is real on this filesystem rather than assuming it.
     * If it ever fails, a platform has made `writeFile` atomic and the fix
     * below became unnecessary there — which is worth finding out loudly.
     */
    it('a plain writeFile really can be read half-written', async () => {
        let torn = 0;
        for (let i = 0; i < ATTEMPTS; i++) {
            const p = path.join(dir, `plain-${i}.jpg`);
            racing(fs.writeFile(p, ENTRY));
            try {
                const got = await fs.readFile(p);
                if (got.length !== ENTRY.length) torn++;
            } catch { /* not there yet — a miss, which is safe */ }
        }
        expect(torn).toBeGreaterThan(0);
    });

    it('never lets a reader see a partial entry', async () => {
        const seen: number[] = [];
        for (let i = 0; i < ATTEMPTS; i++) {
            const p = path.join(dir, `entry-${i}.jpg`);
            racing(writeCacheEntry(p, ENTRY));
            try {
                seen.push((await fs.readFile(p)).length);
            } catch { /* a miss: deriveImage re-derives, and coalesces */ }
        }
        // Every read that found a file found the whole file.
        expect(seen.every(len => len === ENTRY.length)).toBe(true);
    });

    it('leaves the entry byte-identical', async () => {
        const p = path.join(dir, 'entry.jpg');
        await writeCacheEntry(p, ENTRY);
        expect(Buffer.compare(await fs.readFile(p), ENTRY)).toBe(0);
    });

    it('replaces an existing entry without a window where it is partial', async () => {
        const p = path.join(dir, 'entry.jpg');
        const older = Buffer.alloc(ENTRY.length, 0x11);
        await writeCacheEntry(p, older);
        racing(writeCacheEntry(p, ENTRY));
        const got = await fs.readFile(p);
        // Either the old entry or the new one, never a splice of the two.
        expect(got.length).toBe(ENTRY.length);
        expect(Buffer.compare(got, older) === 0 || Buffer.compare(got, ENTRY) === 0).toBe(true);
    });

    it('keeps no temp file behind on success', async () => {
        await writeCacheEntry(path.join(dir, 'entry.jpg'), ENTRY);
        expect(await fs.readdir(dir)).toEqual(['entry.jpg']);
    });

    it('cleans up its temp file when the move fails', async () => {
        // A directory at the destination: the write succeeds, the rename cannot.
        const p = path.join(dir, 'entry.jpg');
        await fs.mkdir(p);
        await expect(writeCacheEntry(p, ENTRY)).rejects.toThrow();
        expect(await fs.readdir(dir)).toEqual(['entry.jpg']);
    });

    it('two writers of the same key do not collide', async () => {
        const p = path.join(dir, 'entry.jpg');
        const other = Buffer.alloc(ENTRY.length, 0x22);
        await Promise.all([writeCacheEntry(p, ENTRY), writeCacheEntry(p, other)]);
        const got = await fs.readFile(p);
        expect(got.length).toBe(ENTRY.length);
        expect(Buffer.compare(got, ENTRY) === 0 || Buffer.compare(got, other) === 0).toBe(true);
        expect(await fs.readdir(dir)).toEqual(['entry.jpg']);
    });
});

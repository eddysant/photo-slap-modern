import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { lookupHashes, storeHashes, isHash } from '../electron/perceptualHashCache';
import { createStampedCache } from '../electron/stampedCache';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const anywhere = () => true;

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-phash-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const touch = async (name: string, body = 'x') => {
    const p = path.join(dir, name);
    await fs.writeFile(p, body);
    return p;
};

describe('what counts as a hash', () => {
    it('is lowercase hex of a plausible length', () => {
        expect(isHash(HASH_A)).toBe(true);
        expect(isHash('0123456789abcdef')).toBe(true);
        for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(300), 42, null, undefined, {}]) {
            expect(isHash(bad)).toBe(false);
        }
    });
});

describe('asking which hashes are still good', () => {
    it('gives every file a stamp and only the remembered ones a hash', async () => {
        const a = await touch('a.jpg'), b = await touch('b.jpg');
        const cache = createStampedCache<string>();
        const first = await lookupHashes([a, b], cache);
        expect(first.known).toEqual({});
        expect(Object.keys(first.stamps).sort()).toEqual([a, b].sort());

        storeHashes([{ path: a, stamp: first.stamps[a], hash: HASH_A }], cache, anywhere);
        const second = await lookupHashes([a, b], cache);
        expect(second.known).toEqual({ [a]: HASH_A });
    });

    it('does not offer the hash of a file as it was before an edit', async () => {
        const a = await touch('a.jpg', 'before');
        const cache = createStampedCache<string>();
        const { stamps } = await lookupHashes([a], cache);
        storeHashes([{ path: a, stamp: stamps[a], hash: HASH_A }], cache, anywhere);

        await fs.writeFile(a, 'after, and a different length');
        const again = await lookupHashes([a], cache);
        expect(again.known).toEqual({});
        expect(again.stamps[a]).not.toBe(stamps[a]); // and it says what the file is now
    });

    /*
     * The case the stamp travels for. A scan takes its stamps at the start
     * and hashes for minutes; a file edited in between is hashed from pixels
     * that may be old or new. Stored against the stamp from the start, the
     * next scan sees a mismatch and hashes it again. Stored against a fresh
     * stat, the new stamp would vouch for whatever was hashed.
     */
    it('a file edited mid-scan is hashed again next time, not vouched for', async () => {
        const a = await touch('a.jpg', 'as the scan found it');
        const cache = createStampedCache<string>();
        const { stamps } = await lookupHashes([a], cache);

        await fs.writeFile(a, 'edited while the scan was still running');
        storeHashes([{ path: a, stamp: stamps[a], hash: HASH_A }], cache, anywhere);

        expect((await lookupHashes([a], cache)).known).toEqual({});
    });

    it('has nothing to say about a file that is gone', async () => {
        const gone = path.join(dir, 'gone.jpg');
        const cache = createStampedCache<string>();
        cache.set(gone, '1:1', HASH_A);
        expect(await lookupHashes([gone], cache)).toEqual({ known: {}, stamps: {} });
    });
});

describe('storing what a scan computed', () => {
    it('keeps well-formed entries and says how many', () => {
        const cache = createStampedCache<string>();
        const stored = storeHashes([
            { path: '/a.jpg', stamp: '1:1', hash: HASH_A },
            { path: '/b.jpg', stamp: '2:2', hash: HASH_B },
        ], cache, anywhere);
        expect(stored).toBe(2);
        expect(cache.get('/a.jpg', '1:1')).toBe(HASH_A);
        expect(cache.get('/b.jpg', '2:2')).toBe(HASH_B);
    });

    it('drops anything malformed without losing the rest', () => {
        const cache = createStampedCache<string>();
        const stored = storeHashes([
            null,
            'nope',
            { path: '/no-stamp.jpg', hash: HASH_A },
            { path: '/bad-hash.jpg', stamp: '1:1', hash: 'not hex' },
            { path: '/short.jpg', stamp: '1:1', hash: 'abc' },
            { path: 7, stamp: '1:1', hash: HASH_A },
            { path: '/ok.jpg', stamp: '1:1', hash: HASH_A },
        ], cache, anywhere);
        expect(stored).toBe(1);
        expect(Object.keys(cache.snapshot())).toEqual(['/ok.jpg']);
    });

    it('is not a way to write about files outside the opened folders', () => {
        const cache = createStampedCache<string>();
        const stored = storeHashes([
            { path: '/library/a.jpg', stamp: '1:1', hash: HASH_A },
            { path: '/etc/passwd', stamp: '1:1', hash: HASH_A },
        ], cache, p => p.startsWith('/library/'));
        expect(stored).toBe(1);
        expect(Object.keys(cache.snapshot())).toEqual(['/library/a.jpg']);
    });

    it('takes a non-list as nothing at all', () => {
        const cache = createStampedCache<string>();
        expect(storeHashes({ path: '/a.jpg', stamp: '1:1', hash: HASH_A }, cache, anywhere)).toBe(0);
        expect(storeHashes(undefined, cache, anywhere)).toBe(0);
        expect(cache.dirty).toBe(false);
    });
});

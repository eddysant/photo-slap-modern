import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    MAX_VERIFIED, type DeepVerifyRecord,
    createDeepVerifyCache, fileStamp, loadDeepVerifyCache, prune,
} from '../electron/deepVerifyCache';

const at = (n: number) => { let t = n; return () => t++; };

describe('createDeepVerifyCache', () => {
    it('knows nothing to begin with', () => {
        const cache = createDeepVerifyCache();
        expect(cache.get('/a.jpg', '1:2')).toBeUndefined();
        expect(cache.hits).toBe(0);
        expect(cache.dirty).toBe(false);
    });

    it('remembers a verdict and counts the decode it saved', () => {
        const cache = createDeepVerifyCache({}, at(1));
        cache.set('/a.jpg', '1:2', true);
        expect(cache.get('/a.jpg', '1:2')).toBe(true);
        expect(cache.hits).toBe(1);
    });

    /**
     * A failure is remembered too. Re-decoding a rotten file every pass is
     * the obvious waste; the subtler point is that a resumed scan must still
     * report it, or it would announce a clean library.
     */
    it('remembers a failure as a failure, not as an absence', () => {
        const cache = createDeepVerifyCache({}, at(1));
        cache.set('/bad.jpg', '1:2', false);
        expect(cache.get('/bad.jpg', '1:2')).toBe(false);
    });

    /**
     * Edited since — resaved, rotated, replaced by a sync — and the verdict
     * is about a file that no longer exists.
     */
    it('forgets a file that has changed', () => {
        const cache = createDeepVerifyCache({}, at(1));
        cache.set('/a.jpg', '100:5', true);
        expect(cache.get('/a.jpg', '100:6')).toBeUndefined();
        expect(cache.get('/a.jpg', '101:5')).toBeUndefined();
        expect(cache.hits).toBe(0);
    });

    it('does not answer for a different file', () => {
        const cache = createDeepVerifyCache({}, at(1));
        cache.set('/a.jpg', '1:2', true);
        expect(cache.get('/b.jpg', '1:2')).toBeUndefined();
    });

    it('starts from what a previous scan left behind', () => {
        const cache = createDeepVerifyCache({ '/a.jpg': { stamp: '1:2', ok: true, at: 5 } });
        expect(cache.get('/a.jpg', '1:2')).toBe(true);
    });

    it('has nothing to save until it is used', () => {
        const cache = createDeepVerifyCache({ '/a.jpg': { stamp: '1:2', ok: true, at: 5 } });
        expect(cache.dirty).toBe(false);
        cache.get('/missing.jpg', '1:2');
        expect(cache.dirty).toBe(false);
        cache.set('/b.jpg', '3:4', true);
        expect(cache.dirty).toBe(true);
    });

    /**
     * A hit is what makes an entry worth keeping. Timestamped on the decode
     * alone, an entry for a file that has been moved or deleted would age at
     * exactly the same rate as one consulted on every scan — so above the
     * cap the dead entries could evict the live ones, which is the one thing
     * the cap must not do.
     */
    it('counts a hit as use, so the cap drops what is no longer wanted', () => {
        const cache = createDeepVerifyCache({
            '/live.jpg': { stamp: '1:2', ok: true, at: 1 },
            '/gone.jpg': { stamp: '3:4', ok: true, at: 2 },
        }, at(50));
        cache.get('/live.jpg', '1:2');
        expect(cache.entries()['/live.jpg'].at).toBe(50);
        expect(cache.entries()['/gone.jpg'].at).toBe(2);
        // So pruning to one keeps the file still in use.
        expect(Object.keys(prune(cache.entries(), 1))).toEqual(['/live.jpg']);
        // And a hit is a reason to write the cache back.
        expect(cache.dirty).toBe(true);
    });

    it('refreshing a hit does not change the verdict', () => {
        const cache = createDeepVerifyCache({ '/bad.jpg': { stamp: '1:2', ok: false, at: 1 } }, at(50));
        expect(cache.get('/bad.jpg', '1:2')).toBe(false);
        expect(cache.get('/bad.jpg', '1:2')).toBe(false);
        expect(cache.entries()['/bad.jpg']).toEqual({ stamp: '1:2', ok: false, at: 51 });
    });

    it('does not mutate the record it was given', () => {
        const initial: DeepVerifyRecord = { '/a.jpg': { stamp: '1:2', ok: true, at: 5 } };
        createDeepVerifyCache(initial).set('/b.jpg', '3:4', true);
        expect(Object.keys(initial)).toEqual(['/a.jpg']);
    });

    it('hands back everything it holds, old and new', () => {
        const cache = createDeepVerifyCache({ '/a.jpg': { stamp: '1:2', ok: true, at: 5 } }, at(9));
        cache.set('/b.jpg', '3:4', false);
        expect(cache.entries()).toEqual({
            '/a.jpg': { stamp: '1:2', ok: true, at: 5 },
            '/b.jpg': { stamp: '3:4', ok: false, at: 9 },
        });
    });

    it('leaves the timestamp of an untouched entry alone', () => {
        const cache = createDeepVerifyCache({ '/a.jpg': { stamp: '1:2', ok: true, at: 5 } }, at(9));
        cache.set('/b.jpg', '3:4', true);
        expect(cache.entries()['/a.jpg'].at).toBe(5);
    });

    it('overwrites a stale verdict rather than keeping both', () => {
        const cache = createDeepVerifyCache({ '/a.jpg': { stamp: '1:2', ok: true, at: 5 } }, at(9));
        cache.set('/a.jpg', '9:9', false);
        expect(cache.entries()).toEqual({ '/a.jpg': { stamp: '9:9', ok: false, at: 9 } });
    });
});

describe('fileStamp', () => {
    it('covers both size and mtime', () => {
        expect(fileStamp(100, 5)).not.toBe(fileStamp(100, 6));
        expect(fileStamp(100, 5)).not.toBe(fileStamp(101, 5));
    });

    /**
     * A fractional mtime is real — some filesystems report sub-millisecond
     * precision and it can differ between two stats of the same untouched
     * file, which would invalidate every entry on every scan.
     */
    it('is stable across a fractional mtime', () => {
        expect(fileStamp(100, 1730000000000.4)).toBe(fileStamp(100, 1730000000000));
    });
});

describe('prune', () => {
    const many = (n: number): DeepVerifyRecord => {
        const record: DeepVerifyRecord = {};
        for (let i = 0; i < n; i++) record[`/f${i}.jpg`] = { stamp: '1:1', ok: true, at: i };
        return record;
    };

    it('leaves a cache under the cap alone, by identity', () => {
        const record = many(10);
        expect(prune(record, 10)).toBe(record);
    });

    it('drops the oldest verdicts first', () => {
        expect(Object.keys(prune(many(5), 2)).sort()).toEqual(['/f3.jpg', '/f4.jpg']);
    });

    it('is applied on the way out', () => {
        const cache = createDeepVerifyCache(many(MAX_VERIFIED), at(MAX_VERIFIED + 10));
        cache.set('/new.jpg', '1:1', true);
        const entries = cache.entries();
        expect(Object.keys(entries).length).toBe(MAX_VERIFIED);
        // The newest is the one the scan just learned.
        expect(entries['/new.jpg']).toBeDefined();
    });
});

describe('loadDeepVerifyCache', () => {
    it('survives a missing or nonsensical file', () => {
        expect(loadDeepVerifyCache(undefined)).toEqual({});
        expect(loadDeepVerifyCache(null)).toEqual({});
        expect(loadDeepVerifyCache('[]')).toEqual({});
        expect(loadDeepVerifyCache(42)).toEqual({});
    });

    it('round-trips what was written', () => {
        const record: DeepVerifyRecord = { '/a.jpg': { stamp: '1:2', ok: false, at: 7 } };
        expect(loadDeepVerifyCache(JSON.parse(JSON.stringify(record)))).toEqual(record);
    });

    /**
     * A bad entry is dropped rather than coerced. `ok` in particular: a
     * missing one defaulted to `true` would be the cache claiming a file is
     * healthy on the strength of nothing, which is the one mistake here that
     * silently weakens a scan the user paid minutes for.
     */
    it('drops entries it cannot make sense of', () => {
        expect(Object.keys(loadDeepVerifyCache({
            good: { stamp: '1:2', ok: true, at: 3 },
            noStamp: { ok: true, at: 3 },
            noOk: { stamp: '1:2', at: 3 },
            okNotBoolean: { stamp: '1:2', ok: 'yes', at: 3 },
            notAnObject: 7,
        }))).toEqual(['good']);
    });

    it('fills in a missing timestamp rather than dropping the verdict', () => {
        expect(loadDeepVerifyCache({ k: { stamp: '1:2', ok: true } }))
            .toEqual({ k: { stamp: '1:2', ok: true, at: 0 } });
    });
});

/**
 * Reads the source. The cache records that a file's *pixels decoded*, and a
 * shallow scan decodes nothing — so if a shallow scan could write to it, the
 * next deep scan would skip the single thing it exists to do, and report a
 * library as fully decoded having decoded none of it. That failure would be
 * invisible: the scan would be fast and the report would look right.
 */
describe('only a deep scan may touch the cache', () => {
    const health = fs.readFileSync(
        path.join(import.meta.dirname, '../electron/libraryHealth.ts'), 'utf8');
    const main = fs.readFileSync(
        path.join(import.meta.dirname, '../electron/main.ts'), 'utf8');

    it('the scan drops the cache it was handed unless it is deep', () => {
        expect(health).toMatch(/const verified = deep \? options\.verified : undefined;/);
    });

    it('and nothing else in the scan reads the option directly', () => {
        const uses = [...health.matchAll(/options\.verified/g)];
        expect(uses.length).toBe(1);
    });

    it('the file inspection only reaches the cache behind the deep flag', () => {
        const from = health.indexOf('async function inspectMediaFile');
        // Bounded at the next top-level function, or `scanLibraryHealth`'s own
        // uses of the cache would be counted as this one's and the check
        // would pass whatever `inspectMediaFile` did.
        const body = health.slice(from, health.indexOf('export async function scanLibraryHealth'));
        expect(body).toContain('decodePixels');
        const block = body.slice(body.indexOf('if (deep) {'), body.indexOf('if (stat.size <'));
        expect(block).toMatch(/verified\?\.get\(/);
        expect(block).toMatch(/verified\?\.set\(/);
        // Every use of the cache is inside that one block.
        const all = [...body.matchAll(/verified\?\./g)].length;
        expect([...block.matchAll(/verified\?\./g)].length).toBe(all);
    });

    it('main builds a cache only for a deep scan', () => {
        expect(main).toMatch(/const verified = deep \? createDeepVerifyCache\(/);
    });

    /**
     * The point of the whole thing: a scan the user stopped has to keep what
     * it decoded, or the cancel and the resume cancel each other out.
     */
    it('main saves the cache after a cancelled scan too', () => {
        const handler = main.slice(main.indexOf("ipcMain.handle('library:health'"));
        const save = handler.slice(0, handler.indexOf('return report;'));
        expect(save).toMatch(/if \(verified\?\.dirty\)/);
        // Not conditioned on how the scan ended.
        expect(save).not.toMatch(/report\.cancelled/);
    });
});

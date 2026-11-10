import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
    createStampedCache, pruneStamped, loadStamped, serializeStamped, openStampedCacheFile, fileStamp,
} from '../electron/stampedCache';

const isNumber = (v: unknown): v is number => typeof v === 'number';
const DAY = 24 * 60 * 60 * 1000;

describe('a value held against a file stamp', () => {
    it('answers only for the file as it was', () => {
        const cache = createStampedCache<number>();
        cache.set('/a.jpg', '10:1', 42);
        expect(cache.get('/a.jpg', '10:1')).toBe(42);
        expect(cache.get('/a.jpg', '11:1')).toBeUndefined(); // edited
        expect(cache.get('/b.jpg', '10:1')).toBeUndefined();
    });

    it('counts only the lookups it answered', () => {
        const cache = createStampedCache<number>();
        cache.set('/a.jpg', 's', 1);
        cache.get('/a.jpg', 's');
        cache.get('/a.jpg', 'other');
        cache.get('/missing.jpg', 's');
        expect(cache.hits).toBe(1);
    });

    it('rounds mtime, which is fractional on some filesystems and not on others', () => {
        expect(fileStamp(10, 1234.4)).toBe(fileStamp(10, 1234.2));
        expect(fileStamp(10, 1234)).not.toBe(fileStamp(11, 1234));
    });

    /*
     * The property that keeps a date sort from rewriting the file at every
     * launch: it hits the whole library, and a hit that always counted as a
     * change would make every read a megabyte write.
     */
    it('is not dirtied by a hit on a fresh entry', () => {
        let now = 1_000_000;
        const cache = createStampedCache<number>({}, { now: () => now });
        cache.set('/a.jpg', 's', 1);
        cache.snapshot();
        expect(cache.dirty).toBe(false);
        now += DAY - 1;
        expect(cache.get('/a.jpg', 's')).toBe(1);
        expect(cache.dirty).toBe(false);
    });

    it('but a hit on a day-old entry does refresh it, so use keeps an entry alive', () => {
        let now = 1_000_000;
        const cache = createStampedCache<number>({}, { now: () => now });
        cache.set('/a.jpg', 's', 1);
        cache.snapshot();
        now += DAY;
        cache.get('/a.jpg', 's');
        expect(cache.dirty).toBe(true);
        expect(cache.snapshot()['/a.jpg'].at).toBe(now);
    });

    it('snapshot clears dirty and prunes to the cap, least recently useful first', () => {
        let now = 0;
        const cache = createStampedCache<number>({}, { max: 2, now: () => now });
        now = 1; cache.set('/old.jpg', 's', 1);
        now = 2; cache.set('/mid.jpg', 's', 2);
        now = 3; cache.set('/new.jpg', 's', 3);
        expect(cache.dirty).toBe(true);
        expect(Object.keys(cache.snapshot()).sort()).toEqual(['/mid.jpg', '/new.jpg']);
        expect(cache.dirty).toBe(false);
        // and the pruned entry is really gone, not just left out of the copy
        expect(cache.get('/old.jpg', 's')).toBeUndefined();
    });

    it('prune leaves a record under the cap untouched', () => {
        const record = { a: { stamp: 's', value: 1, at: 1 } };
        expect(pruneStamped(record, 5)).toBe(record);
    });
});

describe('what comes back off disk', () => {
    const good = { stamp: 's', value: 7, at: 5 };

    it('round-trips through its own serialisation', () => {
        const text = serializeStamped({ '/a.jpg': good }, 3);
        expect(loadStamped(JSON.parse(text), 3, isNumber)).toEqual({ '/a.jpg': good });
    });

    it('retires everything when the version has moved on', () => {
        const text = serializeStamped({ '/a.jpg': good }, 3);
        expect(loadStamped(JSON.parse(text), 4, isNumber)).toEqual({});
    });

    it('treats anything that is not the expected shape as empty', () => {
        expect(loadStamped(null, 1, isNumber)).toEqual({});
        expect(loadStamped('nope', 1, isNumber)).toEqual({});
        expect(loadStamped({ version: 1 }, 1, isNumber)).toEqual({});
        expect(loadStamped({ version: 1, entries: 'x' }, 1, isNumber)).toEqual({});
    });

    it('drops a bad entry and keeps its neighbours', () => {
        const loaded = loadStamped({
            version: 1,
            entries: {
                '/ok.jpg': good,
                '/wrong-type.jpg': { stamp: 's', value: 'seven', at: 1 },
                '/no-stamp.jpg': { value: 7, at: 1 },
                '/null.jpg': null,
                '/no-at.jpg': { stamp: 's', value: 9 },
            },
        }, 1, isNumber);
        expect(Object.keys(loaded).sort()).toEqual(['/no-at.jpg', '/ok.jpg']);
        expect(loaded['/no-at.jpg'].at).toBe(0); // first to go under the cap
    });
});

describe('the cache as a file', () => {
    let dir: string, file: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-stamped-'));
        file = path.join(dir, 'cache.json');
    });
    afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    it('is still there for the next launch', async () => {
        const first = openStampedCacheFile<number>(file, 1, isNumber);
        (await first.cache()).set('/a.jpg', 's', 42);
        await first.flush();

        const second = openStampedCacheFile<number>(file, 1, isNumber);
        expect((await second.cache()).get('/a.jpg', 's')).toBe(42);
    });

    it('takes its path lazily, since userData is not known at import time', async () => {
        let asked = 0;
        const lazy = openStampedCacheFile<number>(() => { asked++; return file; }, 1, isNumber);
        expect(asked).toBe(0);
        (await lazy.cache()).set('/a.jpg', 's', 1);
        await lazy.flush();
        expect(asked).toBeGreaterThan(0);
        expect(await fs.readdir(dir)).toEqual(['cache.json']);
    });

    it('starts empty from a corrupt file rather than failing the lookup', async () => {
        await fs.writeFile(file, '{"version":1,"entries":{"/a.jpg":{"stamp"');
        const opened = openStampedCacheFile<number>(file, 1, isNumber);
        const cache = await opened.cache();
        expect(cache.get('/a.jpg', 's')).toBeUndefined();
        cache.set('/a.jpg', 's', 1);
        await opened.flush();
        expect(JSON.parse(await fs.readFile(file, 'utf8')).entries['/a.jpg'].value).toBe(1);
    });

    it('writes nothing when it was never used, or when nothing changed', async () => {
        const unused = openStampedCacheFile<number>(file, 1, isNumber);
        await unused.flush();
        expect(await fs.readdir(dir)).toEqual([]);

        const used = openStampedCacheFile<number>(file, 1, isNumber);
        (await used.cache()).set('/a.jpg', 's', 1);
        await used.flush();
        const before = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, before + ' '); // a marker a rewrite would erase
        (await used.cache()).get('/a.jpg', 's'); // a hit on a fresh entry
        await used.flush();
        expect(await fs.readFile(file, 'utf8')).toBe(before + ' ');
    });

    it('turns many requests to save into one write, and leaves no temp file', async () => {
        const opened = openStampedCacheFile<number>(file, 1, isNumber, { flushDelayMs: 40 });
        const cache = await opened.cache();
        for (let i = 0; i < 50; i++) {
            cache.set(`/p${i}.jpg`, 's', i);
            opened.scheduleFlush();
        }
        expect(await fs.readdir(dir)).toEqual([]); // nothing yet: it is debounced
        await new Promise(r => setTimeout(r, 200));
        expect(await fs.readdir(dir)).toEqual(['cache.json']);
        expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).entries)).toHaveLength(50);
    });

    /*
     * Two things each make this hold — the flush clears the timer, and a
     * timer that fires anyway finds nothing dirty — and removing either one
     * alone changes nothing observable. The test is of the outcome.
     */
    it('does not write twice when a flush overtakes the debounce', async () => {
        const opened = openStampedCacheFile<number>(file, 1, isNumber, { flushDelayMs: 40 });
        (await opened.cache()).set('/a.jpg', 's', 1);
        opened.scheduleFlush();
        await opened.flush();
        const body = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, body + ' ');
        await new Promise(r => setTimeout(r, 150));
        expect(await fs.readFile(file, 'utf8')).toBe(body + ' ');
    });
});

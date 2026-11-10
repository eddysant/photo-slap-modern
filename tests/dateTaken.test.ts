import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { fileDate, lookupDates, parseExifDate, readDateTaken } from '../electron/dateTaken';
import { createStampedCache } from '../electron/stampedCache';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-dates-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const touch = async (name: string, body = 'x') => {
    const p = path.join(dir, name);
    await fs.writeFile(p, body);
    return p;
};

/** A reader that records what it was asked, since "was the file read" is the claim. */
function reader(answer: number | null | Error) {
    const asked: string[] = [];
    const readTaken = async (p: string) => {
        asked.push(p);
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { asked, readTaken };
}

describe('parsing an EXIF date', () => {
    it('reads the local time the camera wrote', () => {
        expect(parseExifDate('2021:03:04 05:06:07')).toBe(new Date(2021, 2, 4, 5, 6, 7).getTime());
        expect(parseExifDate('2021:03:04T05:06:07')).toBe(new Date(2021, 2, 4, 5, 6, 7).getTime());
    });

    it('declines what is not a date', () => {
        for (const raw of ['', undefined, null, 'yesterday', '2021-03-04 05:06:07', '0000:00:00 00:00:00']) {
            expect(parseExifDate(raw)).toBeNull();
        }
    });
});

describe('remembering when a photo was taken', () => {
    const TAKEN = new Date(2019, 6, 4, 12).getTime();

    it('reads a file once', async () => {
        const p = await touch('a.jpg');
        const cache = createStampedCache<number>();
        const { asked, readTaken } = reader(TAKEN);
        expect(await fileDate(p, { cache, readTaken })).toBe(TAKEN);
        expect(await fileDate(p, { cache, readTaken })).toBe(TAKEN);
        expect(asked).toEqual([p]);
    });

    /*
     * Without this the photos with nothing to find would be the only ones
     * still read at every launch — on a library of screenshots, all of them.
     */
    it('remembers that a file has no date in it, and answers with its mtime', async () => {
        const p = await touch('no-exif.jpg');
        const mtime = (await fs.stat(p)).mtimeMs;
        const cache = createStampedCache<number>();
        const { asked, readTaken } = reader(null);
        expect(await fileDate(p, { cache, readTaken })).toBe(mtime);
        expect(await fileDate(p, { cache, readTaken })).toBe(mtime);
        expect(asked).toHaveLength(1);
    });

    it('does not remember a failure to read, or a blink would pin the photo to its mtime', async () => {
        const p = await touch('on-a-share.jpg');
        const mtime = (await fs.stat(p)).mtimeMs;
        const cache = createStampedCache<number>();
        const failing = reader(new Error('EIO'));
        expect(await fileDate(p, { cache, readTaken: failing.readTaken })).toBe(mtime);
        expect(cache.dirty).toBe(false);

        const working = reader(TAKEN);
        expect(await fileDate(p, { cache, readTaken: working.readTaken })).toBe(TAKEN);
        expect(working.asked).toEqual([p]);
    });

    it('reads an edited file again', async () => {
        const p = await touch('a.jpg', 'before');
        const cache = createStampedCache<number>();
        const { asked, readTaken } = reader(TAKEN);
        await fileDate(p, { cache, readTaken });
        await fs.writeFile(p, 'after, and longer');
        await fileDate(p, { cache, readTaken });
        expect(asked).toHaveLength(2);
    });

    it('answers a video from its stat alone and keeps nothing', async () => {
        const p = await touch('clip.mov');
        const cache = createStampedCache<number>();
        const { asked, readTaken } = reader(TAKEN);
        expect(await fileDate(p, { cache, readTaken })).toBe((await fs.stat(p)).mtimeMs);
        expect(asked).toEqual([]);
        expect(cache.dirty).toBe(false);
    });

    it('answers 0 for a file that is not there', async () => {
        const { asked, readTaken } = reader(TAKEN);
        expect(await fileDate(path.join(dir, 'gone.jpg'), { readTaken })).toBe(0);
        expect(asked).toEqual([]);
    });

    it('works with no cache at all', async () => {
        const p = await touch('a.jpg');
        const { asked, readTaken } = reader(TAKEN);
        await fileDate(p, { readTaken });
        await fileDate(p, { readTaken });
        expect(asked).toHaveLength(2);
    });

    it('looks a whole list up, each file read once however many workers there are', async () => {
        const paths = await Promise.all(Array.from({ length: 40 }, (_, i) => touch(`p${i}.jpg`)));
        const cache = createStampedCache<number>();
        const first = reader(TAKEN);
        const dates = await lookupDates(paths, { cache, readTaken: first.readTaken });
        expect(Object.keys(dates).sort()).toEqual([...paths].sort());
        expect([...first.asked].sort()).toEqual([...paths].sort());

        const second = reader(TAKEN);
        await lookupDates(paths, { cache, readTaken: second.readTaken });
        expect(second.asked).toEqual([]);
        expect(cache.hits).toBe(40);
    });
});

describe('reading the date out of a real file', () => {
    it('finds DateTimeOriginal in a JPEG', async () => {
        const p = path.join(dir, 'dated.jpg');
        await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } })
            .withExif({ IFD2: { DateTimeOriginal: '2019:07:04 12:00:00' } })
            .jpeg().toFile(p);
        expect(await readDateTaken(p)).toBe(new Date(2019, 6, 4, 12).getTime());
    });

    it('answers null for a JPEG carrying none', async () => {
        const p = path.join(dir, 'plain.jpg');
        await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).jpeg().toFile(p);
        expect(await readDateTaken(p)).toBeNull();
    });

    it('throws for a file it cannot open, which is not the same as no date', async () => {
        await expect(readDateTaken(path.join(dir, 'gone.jpg'))).rejects.toThrow();
    });
});

/*
 * Drift guard. The cache only helps if the handler goes through it, and the
 * old handler read EXIF itself — an uncached path coming back would be
 * invisible to every test above.
 */
describe('files:getDates uses the remembered dates', () => {
    const main = fsSync.readFileSync(path.join(import.meta.dirname, '../electron/main.ts'), 'utf8');
    const start = main.indexOf("ipcMain.handle('files:getDates'");
    const end = /\r?\n\}\);/.exec(main.slice(start));
    const handler = main.slice(start, start + (end?.index ?? 0));

    it('finds the handler', () => {
        expect(start).toBeGreaterThan(-1);
        expect(handler.length).toBeGreaterThan(50);
    });

    it('looks dates up through the cache', () => {
        expect(handler).toMatch(/lookupDates\(.*\{\s*cache\s*\}\s*\)/);
        expect(handler).toMatch(/dateCacheFile\.cache\(\)/);
    });

    it('and asks for the cache to be saved when it changed', () => {
        expect(handler).toMatch(/scheduleFlush\(\)/);
    });

    it('main keeps no date reader of its own', () => {
        expect(main).not.toMatch(/dateFromHead|getFileDate|EXIF_DATE_WINDOWS/);
    });
});

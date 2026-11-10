import fs from 'node:fs/promises'
import ExifReader from 'exifreader'
import { fileStamp, type StampedCache } from './stampedCache'

/**
 * When a photo was taken, for the date sort.
 *
 * EXIF dates live near the start of the file, so only its head is read, and
 * anything without a parseable `DateTimeOriginal` falls back to mtime. That
 * much was a handful of functions in `main.ts`. What they could not do there
 * was remember: the renderer kept the answers until another folder was
 * opened, so **every launch under a date sort read the head of every file in
 * the library again** — 64KB at best, 256KB for the ones that needed the
 * wider window, on a photo frame that starts at login and may be reading a
 * network share.
 *
 * A date taken is a fact about the file's bytes, so it is kept against the
 * file's `size:mtime` and survives a restart; an edited or replaced file is
 * read again. Two things about what is and is not remembered:
 *
 * - **"No date in here" is an answer, and is remembered.** A photo with no
 *   EXIF sorts by mtime, and without remembering that the files with nothing
 *   to find would be the only ones still read on every launch — the same
 *   reasoning as `datesRequestedRef` keying off what was asked for.
 * - **"Could not read it" is not an answer, and is not.** A share that
 *   blinked would otherwise pin every photo it held to its mtime until the
 *   file was next edited. The fallback is still returned; it is just not
 *   kept.
 */

const EXIF_DATE_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const DATED_IMAGE = /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i;

/**
 * A date sort reads a window out of every file in the library, so the window
 * size is the whole cost: 256KB across 2,000 photos is 512MB of I/O, measured
 * at 770ms warm on a local SSD and far worse on a network volume. 64KB covers
 * the EXIF block of every file tested, including a HEIC, and is 7x less to
 * read; a camera that writes a large embedded thumbnail ahead of
 * DateTimeOriginal falls through to the old window rather than silently
 * sorting by mtime.
 */
export const EXIF_DATE_WINDOWS = [64 * 1024, 256 * 1024];

/** Bump when what counts as the date changes, so stored answers are retired with the code that gave them. */
export const DATE_CACHE_VERSION = 1;

export function parseExifDate(raw: unknown): number | null {
    const m = raw ? EXIF_DATE_RE.exec(String(raw)) : null;
    if (!m) return null;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return !isNaN(t) && t > 0 ? t : null;
}

async function readHead(filePath: string, bytes: number): Promise<Buffer> {
    const fh = await fs.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
}

/**
 * The embedded date, or null when the file holds none. Throws only when the
 * file could not be read at all — a different thing, which the caller must
 * be able to tell apart.
 */
export async function readDateTaken(filePath: string): Promise<number | null> {
    for (const window of EXIF_DATE_WINDOWS) {
        const head = await readHead(filePath, window);
        try {
            const tags = ExifReader.load(head);
            const taken = parseExifDate(tags['DateTimeOriginal']?.description || tags['CreateDate']?.description);
            if (taken) return taken;
        } catch {
            // truncated or absent EXIF — widen the window, then give up
        }
    }
    return null;
}

export interface DateLookupDeps {
    cache?: StampedCache<number>;
    /** Injected so a test can see whether a file was read. */
    readTaken?: (filePath: string) => Promise<number | null>;
}

export async function fileDate(filePath: string, deps: DateLookupDeps = {}): Promise<number> {
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        return 0;
    }
    // A video's date is its mtime, which the stat just answered: nothing to
    // read, so nothing worth remembering.
    if (!DATED_IMAGE.test(filePath)) return stat.mtimeMs;

    const stamp = fileStamp(stat.size, stat.mtimeMs);
    const known = deps.cache?.get(filePath, stamp);
    if (known !== undefined) return known;

    let taken: number | null;
    try {
        taken = await (deps.readTaken ?? readDateTaken)(filePath);
    } catch {
        return stat.mtimeMs; // unreadable just now — answer, but do not remember
    }
    const date = taken ?? stat.mtimeMs;
    deps.cache?.set(filePath, stamp, date);
    return date;
}

export async function lookupDates(
    paths: string[], deps: DateLookupDeps = {}, concurrency = 16,
): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    let next = 0;
    const worker = async () => {
        while (next < paths.length) {
            const p = paths[next++];
            result[p] = await fileDate(p, deps);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return result;
}

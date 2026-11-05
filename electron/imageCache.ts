import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Write a derived image into the disk cache so no reader can ever see a
 * partial one.
 *
 * `fs.writeFile` to the final path truncates the target and then fills it,
 * which is not atomic — and the cache's read side is a bare `readFile` that
 * treats any successful read as a hit. A request for the same path+dimension
 * arriving inside that window therefore got a **truncated JPEG**, served with
 * a 200 and no error logged anywhere; the renderer's `<img onError>` then
 * skipped a perfectly healthy photo out of the slideshow for the rest of the
 * session. Measured at 192 torn reads in 200 attempts against a 2MB entry.
 *
 * The in-flight coalescing in `deriveImage` does not cover it: the write is
 * started without being awaited, so the job settles and the in-flight key is
 * deleted while the bytes are still going down.
 *
 * So the bytes land in a temp file beside the entry and are moved into place
 * with `rename`, which is atomic within a filesystem: a reader sees either no
 * file at all (a miss, which derives and coalesces) or the whole thing. The
 * temp name is unique per writer, since two callers may derive the same key
 * at once, and the file is cleaned up if anything fails. One left behind by a
 * crash mid-write is no worse than any other entry — the LRU sweep reads
 * every name in the directory, so it is already eligible for eviction.
 */
export async function writeCacheEntry(cachePath: string, buffer: Buffer): Promise<void> {
    const tmp = path.join(
        path.dirname(cachePath),
        `${path.basename(cachePath)}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
        await fs.writeFile(tmp, buffer);
        await fs.rename(tmp, cachePath);
    } catch (e) {
        await fs.unlink(tmp).catch(() => { });
        throw e;
    }
}

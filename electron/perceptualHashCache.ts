import fs from 'node:fs/promises'
import { fileStamp, type StampedCache } from './stampedCache'

/**
 * Perceptual hashes a duplicate scan has already computed.
 *
 * The duplicate history stops a re-scan from *asking* about pairs that have
 * been answered, but finding the pairs still meant hashing the whole library
 * again: a fetch, a decode and a canvas read per photo, and for a video a
 * seek and a frame grab on the main thread at about a second each. The
 * second scan of a library did all of that to rediscover what the first one
 * knew.
 *
 * The renderer does the hashing, so this is two questions asked across the
 * IPC boundary: *which of these do you already have*, and *here are some
 * more*. The stamp travels with them. It is taken when the scan starts and
 * handed back with each hash, rather than read again when the hash is
 * stored: a file edited while it was being hashed then carries the stamp of
 * the file as it was, the next scan sees a mismatch, and it is hashed again.
 * Stat it at store time and the new stamp would vouch for the old pixels.
 */

/**
 * Bump when what is hashed changes — the 256px variant an image is read
 * from, the frame a video is sampled at, the 16-bit blockhash — so hashes
 * the current code would not have produced are not compared against ones it
 * did.
 */
export const HASH_CACHE_VERSION = 1;

const HASH = /^[0-9a-f]{16,256}$/;
export const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

export interface KnownHashes {
    /** Hashes still good for the file as it is now. */
    known: Record<string, string>;
    /** The stamp of every file that could be stat'd, to be handed back with a new hash. */
    stamps: Record<string, string>;
}

export async function lookupHashes(paths: string[], cache: StampedCache<string>): Promise<KnownHashes> {
    const known: Record<string, string> = {};
    const stamps: Record<string, string> = {};
    let next = 0;
    const worker = async () => {
        while (next < paths.length) {
            const p = paths[next++];
            try {
                const stat = await fs.stat(p);
                const stamp = fileStamp(stat.size, stat.mtimeMs);
                stamps[p] = stamp;
                const hash = cache.get(p, stamp);
                if (hash !== undefined) known[p] = hash;
            } catch {
                // gone since it was listed — nothing to say about it
            }
        }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    return { known, stamps };
}

export interface NewHash { path: string; stamp: string; hash: string; }

/** Returns how many were kept; anything malformed is dropped rather than stored. */
export function storeHashes(entries: unknown, cache: StampedCache<string>, isAllowed: (p: string) => boolean): number {
    if (!Array.isArray(entries)) return 0;
    let stored = 0;
    for (const entry of entries as Partial<NewHash>[]) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.stamp !== 'string') continue;
        if (!isHash(entry.hash) || !isAllowed(entry.path)) continue;
        cache.set(entry.path, entry.stamp, entry.hash);
        stored++;
    }
    return stored;
}

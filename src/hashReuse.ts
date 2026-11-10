/**
 * Which files a duplicate scan still has to hash, and how the hashes it did
 * not have to compute rejoin the ones it did.
 *
 * The cache itself lives in main (`electron/perceptualHashCache.ts`); this is
 * the renderer's half, kept pure because the one thing it must get right is
 * invisible from a rendered modal: **the list handed to the grouping must be
 * the same list whatever was cached.** `groupSimilar` walks its input in
 * order and a group's first file is the one the review offers to keep, so a
 * cache that put remembered hashes ahead of fresh ones would change which
 * photo is the keeper depending on whether the library had been scanned
 * before.
 */

export interface PathHash { path: string; hash: string; }
export interface StampedHash extends PathHash { stamp: string; }

export interface HashSplit {
    /** Already hashed, and still the same file. */
    cached: PathHash[];
    /** Still to do. */
    missing: string[];
}

/** Both halves keep the order of `paths`. */
export function splitKnown(paths: string[], known: Record<string, string>): HashSplit {
    const cached: PathHash[] = [];
    const missing: string[] = [];
    for (const path of paths) {
        const hash = known[path];
        if (hash !== undefined) cached.push({ path, hash });
        else missing.push(path);
    }
    return { cached, missing };
}

/**
 * Hashes in the order of `paths`, whichever source each came from. A path
 * with no hash — a file that would not decode — is simply absent, as it
 * always was.
 */
export function inScanOrder(paths: string[], hashes: PathHash[]): PathHash[] {
    const byPath = new Map(hashes.map(h => [h.path, h.hash]));
    const ordered: PathHash[] = [];
    for (const path of paths) {
        const hash = byPath.get(path);
        if (hash !== undefined) ordered.push({ path, hash });
    }
    return ordered;
}

/**
 * Each hash with the stamp its file had when the scan began. One with no
 * stamp is dropped: the file could not be stat'd then, so there is nothing
 * to hold the hash against.
 */
export function withStamps(hashes: PathHash[], stamps: Record<string, string>): StampedHash[] {
    const out: StampedHash[] = [];
    for (const { path, hash } of hashes) {
        const stamp = stamps[path];
        if (stamp !== undefined) out.push({ path, stamp, hash });
    }
    return out;
}

/** What the scan says it is doing; a scan that finishes at once has to say why. */
export function scanStatus(toHash: number, reused: number): string {
    const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
    if (reused === 0) return `Processing ${files(toHash)}...`;
    if (toHash === 0) return `All ${files(reused)} already hashed in an earlier scan...`;
    return `Processing ${files(toHash)} (${reused} already hashed in an earlier scan)...`;
}

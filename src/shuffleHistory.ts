export type ShuffleHistory = Record<string, string[]>;
/** Per-library seed deciding the order of the current shuffle cycle. */
export type ShuffleSeeds = Record<string, number>;

export function makeShuffleHistoryKey(roots: string[], mediaFilter: string): string {
    return `${[...roots].sort().join('|')}::${mediaFilter}`;
}

export function newShuffleSeed(random: () => number = Math.random): number {
    return Math.floor(random() * 0xffffffff) >>> 0;
}

/**
 * FNV-1a of the path, perturbed by the cycle seed. The point is that a path's
 * rank depends on *nothing but itself and the seed* — so removing a file
 * leaves every other file's rank untouched.
 */
function rankOf(path: string, seed: number): number {
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < path.length; i++) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
}

/** Total order: rank, then path, so equal hashes still sort deterministically. */
const byRank = (seed: number) => <T extends { path: string }>(a: T, b: T) =>
    rankOf(a.path, seed) - rankOf(b.path, seed) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Has every eligible item in `items` already been viewed this cycle? */
export function hasSeenEverything<T extends { path: string }>(items: T[], viewedPaths: string[]): boolean {
    if (items.length === 0) return false;
    const eligible = new Set(items.map(item => item.path));
    const seen = new Set(viewedPaths.filter(path => eligible.has(path)));
    return seen.size >= eligible.size;
}

/**
 * Puts every unviewed item before anything already seen. If the current
 * eligible set has been completely viewed, a fresh cycle begins.
 *
 * The order within each half is a deterministic function of the seed, NOT a
 * Fisher-Yates pass. That matters because this runs on every re-derive of the
 * playable list — including after each delete — and a fresh shuffle each time
 * reordered everything still on screen under the user. With a seeded rank,
 * removing a file leaves the remaining order exactly as it was.
 */
export function orderForNoRepeatShuffle<T extends { path: string }>(
    items: T[],
    viewedPaths: string[],
    seed: number,
): { items: T[]; viewedPaths: string[]; cycleReset: boolean } {
    const eligible = new Set(items.map(item => item.path));
    let viewed = [...new Set(viewedPaths.filter(p => eligible.has(p)))];
    const cycleReset = items.length > 0 && viewed.length === items.length;
    if (cycleReset) viewed = [];
    const seen = new Set(viewed);
    const compare = byRank(seed);
    const unseen = items.filter(item => !seen.has(item.path)).sort(compare);
    const alreadySeen = items.filter(item => seen.has(item.path)).sort(compare);
    return { items: [...unseen, ...alreadySeen], viewedPaths: viewed, cycleReset };
}

/**
 * Re-apply the order already in play to a changed set of files.
 *
 * `orderForNoRepeatShuffle` partitions into unseen-then-seen, which is right
 * when a cycle *begins* but wrong to redo mid-cycle: the playable list is
 * re-derived on every delete, and re-partitioning then threw everything
 * already watched to the back, so each delete dumped the viewer at index 0
 * with the counter snapping to "1 / N".
 *
 * Surviving files keep their positions; files that appeared since (a guest
 * upload, a restore) are definitely unseen, so they go to the front in
 * seeded order.
 */
export function reconcileShuffleOrder<T extends { path: string }>(
    items: T[],
    previousOrder: string[],
    seed: number,
): T[] {
    const position = new Map(previousOrder.map((path, index) => [path, index]));
    const known = items.filter(item => position.has(item.path))
        .sort((a, b) => position.get(a.path)! - position.get(b.path)!);
    const added = items.filter(item => !position.has(item.path)).sort(byRank(seed));
    return [...added, ...known];
}

export function recordViewed(history: ShuffleHistory, key: string, path: string): ShuffleHistory {
    const current = history[key] ?? [];
    if (current.includes(path)) return history;
    return { ...history, [key]: [...current, path] };
}

export function getShuffleProgress<T extends { path: string }>(items: T[], viewedPaths: string[]): { viewed: number; total: number } {
    const eligible = new Set(items.map(item => item.path));
    const viewed = new Set(viewedPaths.filter(path => eligible.has(path)));
    return { viewed: viewed.size, total: eligible.size };
}

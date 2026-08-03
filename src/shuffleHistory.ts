export type ShuffleHistory = Record<string, string[]>;

export function makeShuffleHistoryKey(roots: string[], mediaFilter: string): string {
    return `${[...roots].sort().join('|')}::${mediaFilter}`;
}

export function shuffleInPlace<T>(items: T[], random: () => number = Math.random): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

/**
 * Puts every unviewed item before anything already seen. If the current
 * eligible set has been completely viewed, a fresh cycle begins.
 */
export function orderForNoRepeatShuffle<T extends { path: string }>(
    items: T[],
    viewedPaths: string[],
    random: () => number = Math.random,
): { items: T[]; viewedPaths: string[]; cycleReset: boolean } {
    const eligible = new Set(items.map(item => item.path));
    let viewed = [...new Set(viewedPaths.filter(p => eligible.has(p)))];
    const cycleReset = items.length > 0 && viewed.length === items.length;
    if (cycleReset) viewed = [];
    const seen = new Set(viewed);
    const unseen = shuffleInPlace(items.filter(item => !seen.has(item.path)), random);
    const alreadySeen = shuffleInPlace(items.filter(item => seen.has(item.path)), random);
    return { items: [...unseen, ...alreadySeen], viewedPaths: viewed, cycleReset };
}

export function recordViewed(history: ShuffleHistory, key: string, path: string): ShuffleHistory {
    const current = history[key] ?? [];
    if (current.includes(path)) return history;
    return { ...history, [key]: [...current, path] };
}


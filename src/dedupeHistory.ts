/**
 * What the duplicate review has already been told, so a re-scan does not ask
 * again. The unit is a **pair**, not a group: groups are not stable between
 * scans — a different strictness, a file added or deleted, and the same photos
 * fall into a differently-shaped group — but "I looked at these two and they
 * are both staying" is a fact about the two files and nothing else.
 *
 * A deletion needs no record: the file is gone. Only the two non-destructive
 * outcomes are remembered.
 */

export type PairVerdict = 'kept' | 'skipped';

export interface PairDecision {
    verdict: PairVerdict;
    /** Epoch ms, used to decide what to drop when the cap is reached. */
    at: number;
    /** `size:mtime` of each side as it was when the decision was made. */
    stamps: [string, string];
}

export type DedupeHistory = Record<string, PairDecision>;

export interface FileStat { size: number; mtimeMs: number }

/**
 * Enough that nobody reviewing a real library hits it, small enough that the
 * value stays a sensible thing to keep in electron-store.
 */
export const MAX_DECISIONS = 5000;

const SEP = '\u0000';

/**
 * Unordered: the review may put either file on the left next time.
 *
 * Length-prefixed rather than merely separated. `\u0000` is a byte no
 * filesystem admits in a path, which makes a separator alone safe in
 * practice — but only on the strength of an argument about the OS, and the
 * prefix makes the encoding injective for any two strings at all, which is a
 * property this file can state and test for itself.
 */
export function pairKey(a: string, b: string): string {
    const [first, second] = a < b ? [a, b] : [b, a];
    return `${first.length}${SEP}${first}${SEP}${second}`;
}

/** `''` means "not known", which is treated as "do not argue" below. */
export function fileStamp(info?: FileStat): string {
    return info ? `${info.size}:${info.mtimeMs}` : '';
}

/**
 * A decision is about the files as the user saw them. If one has been edited
 * since — resaved, cropped, rotated — the pair is a different question and is
 * worth asking again. An unknown stamp on either side cannot contradict
 * anything, so it does not: the alternative is nagging about a file we simply
 * failed to stat.
 */
function stampAgrees(stored: string, current: string): boolean {
    return stored === '' || current === '' || stored === current;
}

export function isDecided(
    history: DedupeHistory,
    a: string,
    b: string,
    stats: Record<string, FileStat> = {},
): boolean {
    const decision = history[pairKey(a, b)];
    if (!decision) return false;
    const [first, second] = a < b ? [a, b] : [b, a];
    return stampAgrees(decision.stamps[0], fileStamp(stats[first]))
        && stampAgrees(decision.stamps[1], fileStamp(stats[second]));
}

function withPair(
    history: DedupeHistory,
    a: string,
    b: string,
    verdict: PairVerdict,
    stats: Record<string, FileStat>,
    now: number,
): DedupeHistory {
    const [first, second] = a < b ? [a, b] : [b, a];
    return {
        ...history,
        [pairKey(a, b)]: {
            verdict,
            at: now,
            stamps: [fileStamp(stats[first]), fileStamp(stats[second])],
        },
    };
}

/** One pair, which is what "Keep Both" decides. */
export function recordPair(
    history: DedupeHistory,
    a: string,
    b: string,
    verdict: PairVerdict,
    stats: Record<string, FileStat> = {},
    now: number = Date.now(),
): DedupeHistory {
    return prune(withPair(history, a, b, verdict, stats, now));
}

/**
 * Every pair in the group, which is what "Skip Group" decides — the review
 * walks a group pairwise, so recording only the pair on screen would leave a
 * three-file group asking about its third file on the next scan, which is not
 * what skipping it looked like.
 */
export function recordGroup(
    history: DedupeHistory,
    files: string[],
    verdict: PairVerdict,
    stats: Record<string, FileStat> = {},
    now: number = Date.now(),
): DedupeHistory {
    let next = history;
    for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
            next = withPair(next, files[i], files[j], verdict, stats, now);
        }
    }
    return prune(next);
}

/** Oldest decisions go first once the cap is reached. */
export function prune(history: DedupeHistory, max: number = MAX_DECISIONS): DedupeHistory {
    const keys = Object.keys(history);
    if (keys.length <= max) return history;
    const keep = keys
        .sort((x, y) => history[y].at - history[x].at)
        .slice(0, max);
    const next: DedupeHistory = {};
    for (const key of keep) next[key] = history[key];
    return next;
}

/**
 * The group as the review should present it, or `null` when there is nothing
 * left to ask.
 *
 * The review always compares `files[0]` against `files[1]`, and a kept
 * challenger leaves for good — so a decided pair is dropped exactly the way
 * "Keep Both" drops it, rather than by some second rule that could disagree
 * with the live review.
 */
export function undecidedFrom(
    files: string[],
    history: DedupeHistory,
    stats: Record<string, FileStat> = {},
): string[] | null {
    let remaining = files;
    while (remaining.length >= 2 && isDecided(history, remaining[0], remaining[1], stats)) {
        remaining = [remaining[0], ...remaining.slice(2)];
    }
    return remaining.length >= 2 ? remaining : null;
}

/** Shape-checks whatever came back out of the store. */
export function loadHistory(raw: unknown): DedupeHistory {
    if (!raw || typeof raw !== 'object') return {};
    const next: DedupeHistory = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const d = value as Partial<PairDecision>;
        if (!d || typeof d !== 'object') continue;
        if (d.verdict !== 'kept' && d.verdict !== 'skipped') continue;
        const stamps = Array.isArray(d.stamps) ? d.stamps : [];
        next[key] = {
            verdict: d.verdict,
            at: typeof d.at === 'number' ? d.at : 0,
            stamps: [typeof stamps[0] === 'string' ? stamps[0] : '', typeof stamps[1] === 'string' ? stamps[1] : ''],
        };
    }
    return next;
}

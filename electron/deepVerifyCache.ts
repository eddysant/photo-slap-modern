/**
 * What the deep scan has already decoded, so stopping and restarting one
 * does not start over.
 *
 * A deep scan of a real library is minutes of decoding — it has progress and
 * a cancel, but a cancel threw away everything it had learned, so a user who
 * stopped at 90% and came back paid the whole cost again. That is also the
 * reason the cancel was worth having, which made the two features
 * half-pointless together.
 *
 * Only the expensive step is remembered: one boolean per file saying whether
 * its pixels decoded. Everything else a scan reports — tiny dimensions, a
 * missing capture date, an unsupported extension, an orphaned sidecar entry
 * — is cheap and is recomputed every pass, so a resumed report is assembled
 * fresh rather than replayed from a cache. Caching whole issue lists would
 * have meant a report whose wording could outlive the code that produced it.
 *
 * A failure is remembered too, not just a success: a rotten file should not
 * be re-decoded on the next pass, and a resumed scan has to still report it
 * or it would announce a clean library.
 */

export interface DeepVerifyEntry {
    /** `size:mtime` when the decode happened. */
    stamp: string;
    /** Whether the pixels decoded. */
    ok: boolean;
    /**
     * Epoch ms of the last time this verdict was *useful* — written on the
     * decode and refreshed on every hit, so the cap means "least recently
     * useful". Set only on the decode, an entry for a file that has been
     * moved or deleted would age at exactly the same rate as one consulted
     * on every scan, and above the cap the dead ones could crowd out the
     * live ones.
     */
    at: number;
}

export type DeepVerifyRecord = Record<string, DeepVerifyEntry>;

/**
 * Roughly 2MB of JSON at ~110 bytes an entry, written once at the end of a
 * scan and read once at the start. Larger than any library this is likely to
 * meet, and small enough that the file stays something to keep.
 */
export const MAX_VERIFIED = 20_000;

export function fileStamp(size: number, mtimeMs: number): string {
    return `${size}:${Math.round(mtimeMs)}`;
}

export interface DeepVerifyCache {
    /** The remembered verdict, or undefined if this exact file is not in it. */
    get(filePath: string, stamp: string): boolean | undefined;
    set(filePath: string, stamp: string, ok: boolean): void;
    /** How many decodes this scan did not have to do. */
    readonly hits: number;
    /** Whether anything changed, so an unchanged cache is not rewritten. */
    readonly dirty: boolean;
    /** The pruned record to persist. */
    entries(): DeepVerifyRecord;
}

export function createDeepVerifyCache(
    initial: DeepVerifyRecord = {},
    now: () => number = Date.now,
): DeepVerifyCache {
    const record: DeepVerifyRecord = { ...initial };
    let hits = 0;
    let dirty = false;

    return {
        get(filePath, stamp) {
            const entry = record[filePath];
            // A file edited since — resaved, rotated, replaced by a sync —
            // is a different question, so the decode happens again. There is
            // no "unknown stamp" case to be generous about here: the scan
            // has just stat'd the file it is about to read.
            if (!entry || entry.stamp !== stamp) return undefined;
            hits++;
            // A hit is what makes an entry worth keeping, so it counts as
            // use. That means a scan which only hits still has something to
            // write — one file at the end of a scan, against the minutes of
            // decoding this exists to avoid.
            record[filePath] = { ...entry, at: now() };
            dirty = true;
            return entry.ok;
        },
        set(filePath, stamp, ok) {
            record[filePath] = { stamp, ok, at: now() };
            dirty = true;
        },
        get hits() { return hits; },
        get dirty() { return dirty; },
        entries() { return prune(record); },
    };
}

/** Oldest verdicts go first once the cap is reached. */
export function prune(record: DeepVerifyRecord, max: number = MAX_VERIFIED): DeepVerifyRecord {
    const keys = Object.keys(record);
    if (keys.length <= max) return record;
    const keep = keys.sort((a, b) => record[b].at - record[a].at).slice(0, max);
    const next: DeepVerifyRecord = {};
    for (const key of keep) next[key] = record[key];
    return next;
}

/** Shape-checks whatever came back off disk. */
export function loadDeepVerifyCache(raw: unknown): DeepVerifyRecord {
    if (!raw || typeof raw !== 'object') return {};
    const next: DeepVerifyRecord = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as Partial<DeepVerifyEntry>;
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.stamp !== 'string' || typeof entry.ok !== 'boolean') continue;
        next[key] = {
            stamp: entry.stamp,
            ok: entry.ok,
            at: typeof entry.at === 'number' ? entry.at : 0,
        };
    }
    return next;
}

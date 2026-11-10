import fs from 'node:fs/promises'
import { writeCacheEntry } from './imageCache'

/**
 * Something expensive that was learned about a file, remembered for as long
 * as the file stays the file it was.
 *
 * `deepVerifyCache.ts` was the first of these — whether a photo's pixels
 * decoded — and the same shape turned up twice more: a photo's perceptual
 * hash, which a duplicate scan recomputed for the whole library every time it
 * ran, and its date taken, which a date sort re-read out of every file on
 * every launch. Each is a fact about a file's bytes, so each is keyed by the
 * path and held against a `size:mtime` stamp: an edited file is a different
 * question, and gets asked again.
 *
 * What is generic lives here; what a value means stays with its caller.
 */

export interface StampedEntry<T> {
    /** `size:mtime` of the file the value was computed from. */
    stamp: string;
    value: T;
    /** Epoch ms of the last time this entry was useful; what the cap prunes by. */
    at: number;
}

export type StampedRecord<T> = Record<string, StampedEntry<T>>;

export function fileStamp(size: number, mtimeMs: number): string {
    return `${size}:${Math.round(mtimeMs)}`;
}

export interface StampedCacheOptions {
    /** Entries kept; the least recently useful go first. */
    max?: number;
    /**
     * How stale `at` may get before a hit refreshes it. A hit has to count as
     * use, or entries for files that are consulted on every launch would age
     * out at the same rate as ones for files long gone. But refreshing on
     * every hit makes every read a write: a date sort hits the whole library
     * at every launch, and would rewrite a megabyte of JSON each time to
     * record that nothing changed. A day is far finer than the cap needs.
     */
    touchAfterMs?: number;
    now?: () => number;
}

export interface StampedCache<T> {
    /** The remembered value, or undefined if this exact file is not in it. */
    get(filePath: string, stamp: string): T | undefined;
    set(filePath: string, stamp: string, value: T): void;
    /** How many lookups were answered from memory. */
    readonly hits: number;
    /** Whether anything changed, so an unchanged cache is not rewritten. */
    readonly dirty: boolean;
    /** The pruned record to persist; clears `dirty`. */
    snapshot(): StampedRecord<T>;
}

export const DEFAULT_MAX_ENTRIES = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createStampedCache<T>(
    initial: StampedRecord<T> = {},
    { max = DEFAULT_MAX_ENTRIES, touchAfterMs = DAY_MS, now = Date.now }: StampedCacheOptions = {},
): StampedCache<T> {
    let record: StampedRecord<T> = { ...initial };
    let hits = 0;
    let dirty = false;

    return {
        get(filePath, stamp) {
            const entry = record[filePath];
            if (!entry || entry.stamp !== stamp) return undefined;
            hits++;
            const t = now();
            if (t - entry.at >= touchAfterMs) {
                record[filePath] = { ...entry, at: t };
                dirty = true;
            }
            return entry.value;
        },
        set(filePath, stamp, value) {
            record[filePath] = { stamp, value, at: now() };
            dirty = true;
        },
        get hits() { return hits; },
        get dirty() { return dirty; },
        snapshot() {
            record = pruneStamped(record, max);
            dirty = false;
            return record;
        },
    };
}

/** Least recently useful entries go first once the cap is reached. */
export function pruneStamped<T>(record: StampedRecord<T>, max: number): StampedRecord<T> {
    const keys = Object.keys(record);
    if (keys.length <= max) return record;
    const keep = keys.sort((a, b) => record[b].at - record[a].at).slice(0, max);
    const next: StampedRecord<T> = {};
    for (const key of keep) next[key] = record[key];
    return next;
}

/**
 * Shape-checks whatever came back off disk. The file is wrapped in a version
 * so a change to how a value is computed — a different hash size, a different
 * EXIF tag — can retire every stored answer at once rather than serving
 * values the current code would not have produced.
 */
export function loadStamped<T>(
    raw: unknown,
    version: number,
    isValue: (value: unknown) => value is T,
): StampedRecord<T> {
    if (!raw || typeof raw !== 'object') return {};
    const file = raw as { version?: unknown; entries?: unknown };
    if (file.version !== version || !file.entries || typeof file.entries !== 'object') return {};
    const next: StampedRecord<T> = {};
    for (const [key, candidate] of Object.entries(file.entries as Record<string, unknown>)) {
        const entry = candidate as Partial<StampedEntry<unknown>> | null;
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.stamp !== 'string' || !isValue(entry.value)) continue;
        next[key] = { stamp: entry.stamp, value: entry.value, at: typeof entry.at === 'number' ? entry.at : 0 };
    }
    return next;
}

export function serializeStamped<T>(record: StampedRecord<T>, version: number): string {
    return JSON.stringify({ version, entries: record });
}

/**
 * A stamped cache kept in one JSON file.
 *
 * Loaded once, on first use, and written on a trailing debounce: a duplicate
 * scan hands hashes over in batches as it goes — so that cancelling one
 * twenty minutes in keeps what it managed, the lesson the deep health scan
 * already paid for — and rewriting the whole file per batch would be a couple
 * of hundred megabyte-sized writes to record one scan. The write is a rename,
 * for the reason every other write into `userData` is: a file torn by a quit
 * mid-write parses as nothing, and the cache it replaced is gone.
 */
export interface StampedCacheFile<T> {
    cache(): Promise<StampedCache<T>>;
    /** Ask for a write soon; many calls make one write. */
    scheduleFlush(): void;
    /** Write now if anything changed. Safe to call when nothing was loaded. */
    flush(): Promise<void>;
}

export function openStampedCacheFile<T>(
    filePath: string | (() => string),
    version: number,
    isValue: (value: unknown) => value is T,
    options: StampedCacheOptions & { flushDelayMs?: number } = {},
): StampedCacheFile<T> {
    const { flushDelayMs = 2000, ...cacheOptions } = options;
    const where = () => (typeof filePath === 'function' ? filePath() : filePath);
    let loaded: Promise<StampedCache<T>> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cache = () => {
        loaded ??= fs.readFile(where(), 'utf8')
            .then(text => loadStamped(JSON.parse(text), version, isValue), () => ({}))
            // Unparseable is the same as absent: start again rather than fail a lookup.
            .catch(() => ({}))
            .then(record => createStampedCache<T>(record, cacheOptions));
        return loaded;
    };

    const flush = async () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!loaded) return;
        const current = await loaded;
        if (!current.dirty) return;
        const body = Buffer.from(serializeStamped(current.snapshot(), version));
        await writeCacheEntry(where(), body).catch(() => { /* a cache that cannot be saved is only slower next time */ });
    };

    return {
        cache,
        scheduleFlush() {
            if (timer) return;
            timer = setTimeout(() => { timer = null; void flush(); }, flushDelayMs);
        },
        flush,
    };
}

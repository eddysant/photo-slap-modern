import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    getShuffleProgress,
    newShuffleSeed,
    orderForNoRepeatShuffle,
    recordViewed,
    type ShuffleHistory,
    type ShuffleSeeds,
} from '../shuffleHistory';

/**
 * The bookkeeping behind no-repeat shuffle: what has been seen, in what
 * order, under which seed, and when a cycle is over.
 *
 * Three stores, deliberately kept apart:
 *
 * - **Viewed paths** persist in app storage, not the library sidecar, so the
 *   show does not repeat itself after a restart without writing to anyone's
 *   photo folders. Written on a debounce — every slide appends one path, and
 *   saving on each meant serialising a library-sized list every few seconds
 *   for data only read at startup.
 * - **Seeds** persist beside them rather than inside them, so an older saved
 *   history (a bare array of paths) still loads and a library without a seed
 *   simply gets one.
 * - **The order in play** is session-only: a fresh launch should re-partition
 *   so anything unseen comes first again.
 *
 * Everything is keyed by library — sorted roots plus the media filter — so
 * opening a different folder set does not disturb this one's cycle.
 */
export const HISTORY_WRITE_DEBOUNCE_MS = 5000;

export interface ShuffleProgress {
    viewed: number;
    total: number;
}

export function useShuffleCycle() {
    const historyRef = useRef<ShuffleHistory>({});
    const seedsRef = useRef<ShuffleSeeds>({});
    const orderRef = useRef<Record<string, string[]>>({});

    const [ready, setReady] = useState(false);
    const [progress, setProgress] = useState<ShuffleProgress>({ viewed: 0, total: 0 });

    useEffect(() => {
        // Each read catches for itself: `Promise.all` reports the first
        // rejection and leaves the second unhandled, which crashes a process
        // that treats unhandled rejections as fatal.
        Promise.all([
            window.api.getStore('shuffleHistory').catch(() => null),
            window.api.getStore('shuffleSeeds').catch(() => null),
        ])
            .then(([history, seeds]) => {
                if (history && typeof history === 'object') historyRef.current = history as ShuffleHistory;
                if (seeds && typeof seeds === 'object') seedsRef.current = seeds as ShuffleSeeds;
            })
            .finally(() => setReady(true));
    }, []);

    const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flush = useCallback(() => {
        if (!writeTimer.current) return;
        clearTimeout(writeTimer.current);
        writeTimer.current = null;
        window.api.setStore('shuffleHistory', historyRef.current);
    }, []);

    const persist = useCallback((history: ShuffleHistory) => {
        historyRef.current = history;
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(() => {
            writeTimer.current = null;
            window.api.setStore('shuffleHistory', historyRef.current);
        }, HISTORY_WRITE_DEBOUNCE_MS);
    }, []);

    // Don't lose the tail of a session on quit or reload
    useEffect(() => {
        window.addEventListener('beforeunload', flush);
        return () => {
            window.removeEventListener('beforeunload', flush);
            flush();
        };
    }, [flush]);

    /** Paths already seen this cycle, for one library. */
    const viewedIn = useCallback((key: string) => historyRef.current[key] ?? [], []);

    /** The order in play, or undefined before a cycle has established one. */
    const orderIn = useCallback((key: string) => orderRef.current[key], []);

    const rememberOrder = useCallback((key: string, paths: string[]) => {
        orderRef.current[key] = paths;
    }, []);

    /** Drop the running order so the next derive re-partitions from scratch. */
    const forgetOrder = useCallback((key?: string) => {
        if (key) delete orderRef.current[key];
        else orderRef.current = {};
    }, []);

    /** The cycle seed for a library, minting and persisting one when needed. */
    const seedFor = useCallback((key: string, fresh = false) => {
        const existing = seedsRef.current[key];
        if (!fresh && typeof existing === 'number') return existing;
        const seed = newShuffleSeed();
        seedsRef.current = { ...seedsRef.current, [key]: seed };
        window.api.setStore('shuffleSeeds', seedsRef.current);
        return seed;
    }, []);

    /** Replace the viewed list for a library, persisting it. */
    const setViewed = useCallback((key: string, paths: string[]) => {
        persist({ ...historyRef.current, [key]: paths });
    }, [persist]);

    /**
     * Note that a slide has been seen. Recorded as soon as it is displayed,
     * so quitting cannot make the next launch repeat it.
     */
    const recordView = useCallback(<T extends { path: string }>(
        key: string, path: string, items: T[],
    ) => {
        const next = recordViewed(historyRef.current, key, path);
        if (next !== historyRef.current) persist(next);
        setProgress(getShuffleProgress(items, next[key] ?? []));
    }, [persist]);

    /** Forget what has been seen, without touching the order. */
    const clearViewed = useCallback((key: string, total: number) => {
        setViewed(key, []);
        setProgress({ viewed: 0, total });
    }, [setViewed]);

    /**
     * Start the next cycle: forget what was seen and mint a new order under a
     * new seed. Without the new seed the next pass replays the one that just
     * finished. Returns the reordered list for the caller to show.
     */
    const startNewCycle = useCallback(<T extends { path: string }>(key: string, items: T[]): T[] => {
        clearViewed(key, items.length);
        const reshuffled = orderForNoRepeatShuffle(items, [], seedFor(key, true)).items;
        rememberOrder(key, reshuffled.map(item => item.path));
        return reshuffled;
    }, [clearViewed, rememberOrder, seedFor]);

    // Every callback above is stable; the object holding them must be too, or
    // the derive that depends on it re-runs on every render and sets a fresh
    // list each time — a render loop. `progress` and `ready` do change, so
    // consumers inside a dependency array name the callbacks they use rather
    // than the whole object.
    return useMemo(() => ({
        ready,
        progress,
        setProgress,
        viewedIn,
        orderIn,
        rememberOrder,
        forgetOrder,
        seedFor,
        setViewed,
        recordView,
        clearViewed,
        startNewCycle,
    }), [
        ready, progress, viewedIn, orderIn, rememberOrder, forgetOrder,
        seedFor, setViewed, recordView, clearViewed, startNewCycle,
    ]);
}

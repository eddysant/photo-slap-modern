// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_WRITE_DEBOUNCE_MS, useShuffleCycle } from '../src/hooks/useShuffleCycle';

const KEY = '/lib::both';
const file = (name: string) => ({ path: `/lib/${name}` });
const library = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(file);

let store: Record<string, unknown>;
let writes: { key: string; value: unknown }[];

beforeEach(() => {
    store = {};
    writes = [];
    (globalThis as any).window.api = {
        getStore: vi.fn(async (key: string) => store[key]),
        setStore: vi.fn((key: string, value: unknown) => { writes.push({ key, value }); store[key] = value; }),
    };
});

// Vitest runs without globals, so testing-library never registers its own
// cleanup: without this every hook mounted in this file stays alive and
// answers the next test's beforeunload.
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** Mounted and past the initial load, which is what `ready` gates. */
const mount = async () => {
    const hook = renderHook(() => useShuffleCycle());
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    return hook;
};

const historyWrites = () => writes.filter(w => w.key === 'shuffleHistory');

describe('loading what was saved', () => {
    it('reads the viewed list and the seeds', async () => {
        store.shuffleHistory = { [KEY]: ['/lib/a.jpg'] };
        store.shuffleSeeds = { [KEY]: 99 };
        const { result } = await mount();
        expect(result.current.viewedIn(KEY)).toEqual(['/lib/a.jpg']);
        expect(result.current.seedFor(KEY)).toBe(99);
    });

    /**
     * Seeds live beside the viewed list rather than inside it, so a history
     * saved by an older version — a bare array of paths, no seed — still
     * loads and simply gets one.
     */
    it('gives a library with saved history but no seed a fresh one', async () => {
        store.shuffleHistory = { [KEY]: ['/lib/a.jpg'] };
        const { result } = await mount();
        const seed = result.current.seedFor(KEY);
        expect(typeof seed).toBe('number');
        expect(result.current.viewedIn(KEY)).toEqual(['/lib/a.jpg']);
    });

    it('becomes ready even when nothing was saved', async () => {
        const { result } = await mount();
        expect(result.current.viewedIn(KEY)).toEqual([]);
    });

    /** The derive waits on `ready`; never becoming ready would hang the show. */
    it('becomes ready even when the store throws', async () => {
        (globalThis as any).window.api.getStore = vi.fn(async () => { throw new Error('nope'); });
        const { result } = renderHook(() => useShuffleCycle());
        await waitFor(() => expect(result.current.ready).toBe(true));
    });

    it('ignores a saved value that is not an object', async () => {
        store.shuffleHistory = 'corrupt';
        const { result } = await mount();
        expect(result.current.viewedIn(KEY)).toEqual([]);
    });
});

describe('seeds', () => {
    it('mints one once and keeps returning it', async () => {
        const { result } = await mount();
        const first = result.current.seedFor(KEY);
        expect(result.current.seedFor(KEY)).toBe(first);
    });

    it('persists a minted seed immediately', async () => {
        const { result } = await mount();
        const seed = result.current.seedFor(KEY);
        expect((store.shuffleSeeds as Record<string, number>)[KEY]).toBe(seed);
    });

    it('mints a different one on request', async () => {
        const { result } = await mount();
        const first = result.current.seedFor(KEY);
        const second = result.current.seedFor(KEY, true);
        expect(second).not.toBe(first);
        expect(result.current.seedFor(KEY)).toBe(second);
    });

    it('keeps libraries apart', async () => {
        const { result } = await mount();
        expect(result.current.seedFor('/a::both')).not.toBe(result.current.seedFor('/b::both'));
    });
});

describe('recording what has been seen', () => {
    it('records a slide and reports progress', async () => {
        const { result } = await mount();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        expect(result.current.viewedIn(KEY)).toEqual(['/lib/a.jpg']);
        expect(result.current.progress).toEqual({ viewed: 1, total: 4 });
    });

    it('does not record the same slide twice', async () => {
        const { result } = await mount();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        expect(result.current.viewedIn(KEY)).toEqual(['/lib/a.jpg']);
        expect(result.current.progress.viewed).toBe(1);
    });

    /** A path that has left the library should not inflate the counter. */
    it('counts only what is still in the library', async () => {
        store.shuffleHistory = { [KEY]: ['/lib/a.jpg', '/lib/deleted.jpg'] };
        const { result } = await mount();
        act(() => { result.current.recordView(KEY, '/lib/b.jpg', library); });
        expect(result.current.progress).toEqual({ viewed: 2, total: 4 });
    });
});

describe('writing to disk', () => {
    /**
     * Every slide appends one path. Saving on each meant serialising a
     * library-sized list to app storage every few seconds, for data that is
     * only read at startup.
     */
    it('coalesces a run of slides into one write', async () => {
        const { result } = await mount();
        vi.useFakeTimers();
        act(() => {
            result.current.recordView(KEY, '/lib/a.jpg', library);
            result.current.recordView(KEY, '/lib/b.jpg', library);
            result.current.recordView(KEY, '/lib/c.jpg', library);
        });
        expect(historyWrites()).toHaveLength(0);
        act(() => { vi.advanceTimersByTime(HISTORY_WRITE_DEBOUNCE_MS); });
        expect(historyWrites()).toHaveLength(1);
        expect((historyWrites()[0].value as Record<string, string[]>)[KEY]).toHaveLength(3);
    });

    it('reports the newest state from memory before the write lands', async () => {
        const { result } = await mount();
        vi.useFakeTimers();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        expect(result.current.viewedIn(KEY)).toEqual(['/lib/a.jpg']);
        expect(historyWrites()).toHaveLength(0);
    });

    /** Quitting must not lose the tail of a session. */
    it('flushes a pending write on unmount', async () => {
        const { result, unmount } = await mount();
        vi.useFakeTimers();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        act(() => { unmount(); });
        expect(historyWrites()).toHaveLength(1);
    });

    it('flushes a pending write when the window goes away', async () => {
        const { result } = await mount();
        vi.useFakeTimers();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        act(() => { window.dispatchEvent(new Event('beforeunload')); });
        expect(historyWrites()).toHaveLength(1);
    });

    it('does not write on unmount when nothing is pending', async () => {
        const { unmount } = await mount();
        vi.useFakeTimers();
        act(() => { unmount(); });
        expect(historyWrites()).toHaveLength(0);
    });
});

describe('the running order', () => {
    it('has none until one is remembered', async () => {
        const { result } = await mount();
        expect(result.current.orderIn(KEY)).toBeUndefined();
        act(() => { result.current.rememberOrder(KEY, ['/lib/b.jpg', '/lib/a.jpg']); });
        expect(result.current.orderIn(KEY)).toEqual(['/lib/b.jpg', '/lib/a.jpg']);
    });

    it('forgets one library without touching another', async () => {
        const { result } = await mount();
        act(() => {
            result.current.rememberOrder('/a::both', ['/a/1.jpg']);
            result.current.rememberOrder('/b::both', ['/b/1.jpg']);
            result.current.forgetOrder('/a::both');
        });
        expect(result.current.orderIn('/a::both')).toBeUndefined();
        expect(result.current.orderIn('/b::both')).toEqual(['/b/1.jpg']);
    });

    it('forgets every library when asked for all of them', async () => {
        const { result } = await mount();
        act(() => {
            result.current.rememberOrder('/a::both', ['/a/1.jpg']);
            result.current.rememberOrder('/b::both', ['/b/1.jpg']);
            result.current.forgetOrder();
        });
        expect(result.current.orderIn('/a::both')).toBeUndefined();
        expect(result.current.orderIn('/b::both')).toBeUndefined();
    });
});

describe('starting the next cycle', () => {
    it('forgets what was seen and resets the counter', async () => {
        const { result } = await mount();
        act(() => { result.current.recordView(KEY, '/lib/a.jpg', library); });
        act(() => { result.current.startNewCycle(KEY, library); });
        expect(result.current.viewedIn(KEY)).toEqual([]);
        expect(result.current.progress).toEqual({ viewed: 0, total: 4 });
    });

    it('returns every file, reordered', async () => {
        const { result } = await mount();
        let next: { path: string }[] = [];
        act(() => { next = result.current.startNewCycle(KEY, library); });
        expect([...next].map(f => f.path).sort()).toEqual(library.map(f => f.path).sort());
    });

    it('remembers the order it just produced', async () => {
        const { result } = await mount();
        let next: { path: string }[] = [];
        act(() => { next = result.current.startNewCycle(KEY, library); });
        expect(result.current.orderIn(KEY)).toEqual(next.map(f => f.path));
    });

    /**
     * Without a new seed the next pass replays the order the finished cycle
     * just used, which is the opposite of what starting over means.
     */
    it('mints a new seed, so the next cycle is not the last one again', async () => {
        const { result } = await mount();
        const before = result.current.seedFor(KEY);
        act(() => { result.current.startNewCycle(KEY, library); });
        expect(result.current.seedFor(KEY)).not.toBe(before);
    });

    it('copes with an empty library', async () => {
        const { result } = await mount();
        let next: { path: string }[] = [];
        act(() => { next = result.current.startNewCycle(KEY, []); });
        expect(next).toEqual([]);
        expect(result.current.progress).toEqual({ viewed: 0, total: 0 });
    });
});

describe('clearing without reshuffling', () => {
    it('forgets the viewed list and keeps the order', async () => {
        const { result } = await mount();
        act(() => {
            result.current.rememberOrder(KEY, ['/lib/b.jpg']);
            result.current.recordView(KEY, '/lib/a.jpg', library);
            result.current.clearViewed(KEY, library.length);
        });
        expect(result.current.viewedIn(KEY)).toEqual([]);
        expect(result.current.progress).toEqual({ viewed: 0, total: 4 });
        expect(result.current.orderIn(KEY)).toEqual(['/lib/b.jpg']);
    });
});

/**
 * The derive depends on this object. A fresh one per render makes the
 * callback that reads it unstable, the derive re-runs, it sets a new list,
 * that renders — a loop that never settles.
 */
describe('identity', () => {
    it('is unchanged by a render that changes nothing', async () => {
        const { result, rerender } = await mount();
        const before = result.current;
        rerender();
        expect(result.current).toBe(before);
    });

    it('keeps its callbacks when progress changes', async () => {
        const { result } = await mount();
        const before = result.current.recordView;
        act(() => { result.current.setProgress({ viewed: 3, total: 9 }); });
        expect(result.current.progress.viewed).toBe(3);
        expect(result.current.recordView).toBe(before);
    });
});

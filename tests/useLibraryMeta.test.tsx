// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibraryMeta, type MetadataStorage } from '../src/hooks/useLibraryMeta';

/**
 * The hook, not its pure parts.
 *
 * `createSidecarSaver` is tested on its own against a fake clock, which
 * covers the policy. What it cannot cover is the wiring: that the saver is
 * built and configured before anything can edit, that the mode reaches it,
 * that the roots travel with the edit, and that quitting flushes. Each of
 * those is an effect, and effects were where this hook's bugs lived.
 */

const EMPTY_META: LibraryMeta = { favorites: [], tags: {}, tagNames: [], ratings: {}, culling: {} };

let saves: { roots: string[]; meta: LibraryMeta }[];

beforeEach(() => {
    vi.useFakeTimers();
    saves = [];
    (globalThis as any).window.api = {
        libraryLoad: vi.fn(async () => EMPTY_META),
        librarySave: vi.fn(async (roots: string[], meta: LibraryMeta) => { saves.push({ roots, meta }); }),
    };
});

// Vitest runs without globals, so testing-library registers no cleanup of
// its own and hooks would outlive their tests.
afterEach(() => { cleanup(); vi.useRealTimers(); });

const mount = (dirs = ['/lib'], storage: MetadataStorage = 'sidecar') =>
    renderHook(
        ({ d, s }: { d: string[]; s: MetadataStorage }) => useLibraryMeta(d, s),
        { initialProps: { d: dirs, s: storage } },
    );

/**
 * Past the 800ms save debounce. Synchronous on purpose: the write records
 * itself the moment the timer fires, so awaiting here would only invite the
 * fake clock and React's async work to fight each other.
 */
const settle = () => { act(() => { vi.advanceTimersByTime(1000); }); };

describe('useLibraryMeta writing', () => {
    it('saves a favorite to the opened roots', () => {
        const { result } = mount();
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        settle();
        expect(saves).toHaveLength(1);
        expect(saves[0].roots).toEqual(['/lib']);
        expect(saves[0].meta.favorites).toEqual(['/lib/a.jpg']);
    });

    /**
     * The mode has to have reached the saver before the first edit can. It
     * is built in an effect; if configuring it ever moves to a second effect
     * that runs first, the saver keeps its default and this is the only
     * thing that notices.
     */
    it('writes nothing at all when mounted in memory mode', async () => {
        const { result } = mount(['/lib'], 'memory');
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        settle();
        expect(saves).toEqual([]);
        expect(result.current.favorites.has('/lib/a.jpg')).toBe(true);
    });

    it('stops writing when the setting changes to memory', async () => {
        const { result, rerender } = mount();
        rerender({ d: ['/lib'], s: 'memory' });
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        settle();
        expect(saves).toEqual([]);
    });

    it('drops a write queued just before the switch', async () => {
        const { result, rerender } = mount();
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        rerender({ d: ['/lib'], s: 'memory' });   // inside the debounce
        settle();
        expect(saves).toEqual([]);
    });

    it('writes the session when the setting changes back to sidecars', async () => {
        const { result, rerender } = mount(['/lib'], 'memory');
        act(() => { result.current.setTag('/lib/a.jpg', 'beach', true); });
        settle();
        expect(saves).toEqual([]);

        act(() => { rerender({ d: ['/lib'], s: 'sidecar' }); });
        expect(saves).toHaveLength(1);
        expect(saves[0].meta.tags).toEqual({ '/lib/a.jpg': ['beach'] });
    });

    /**
     * The library-wiping bug: an edit in one library and another opened
     * inside the debounce. Writing the first library's metadata against the
     * second library's roots empties the second library's sidecar.
     */
    it('writes to the library the edit was made in, not the one now open', async () => {
        const { result, rerender } = mount(['/library-a']);
        act(() => { result.current.setFavorite(['/library-a/a.jpg'], true); });
        rerender({ d: ['/library-b'], s: 'sidecar' });
        settle();
        expect(saves).toHaveLength(1);
        expect(saves[0].roots).toEqual(['/library-a']);
        expect(saves[0].meta.favorites).toEqual(['/library-a/a.jpg']);
    });

    it('flushes a pending write when the app goes away', async () => {
        const { result, unmount } = mount();
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        expect(saves).toEqual([]);
        act(() => { unmount(); });
        expect(saves).toHaveLength(1);
        expect(saves[0].meta.favorites).toEqual(['/lib/a.jpg']);
    });

    it('has nothing to flush when the session is memory-only', async () => {
        const { result, unmount } = mount(['/lib'], 'memory');
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        act(() => { unmount(); });
        expect(saves).toEqual([]);
    });

    it('coalesces a burst of edits into one write', async () => {
        const { result } = mount();
        act(() => {
            result.current.setFavorite(['/lib/a.jpg'], true);
            result.current.setRating(['/lib/a.jpg'], 5);
            result.current.setTag('/lib/a.jpg', 'beach', true);
        });
        settle();
        expect(saves).toHaveLength(1);
        expect(saves[0].meta.ratings).toEqual({ '/lib/a.jpg': 5 });
    });

    /** StrictMode double-invokes effects; a save must not be doubled. */
    it('writes once under StrictMode', async () => {
        const { result } = renderHook(() => useLibraryMeta(['/lib'], 'sidecar'), { wrapper: StrictMode });
        act(() => { result.current.setFavorite(['/lib/a.jpg'], true); });
        settle();
        expect(saves).toHaveLength(1);
    });
});

describe('useLibraryMeta loading', () => {
    // Real timers here: these wait on the load promise, not on the debounce.
    beforeEach(() => { vi.useRealTimers(); });

    it('reads existing sidecars even when writing is off', async () => {
        (globalThis as any).window.api.libraryLoad = vi.fn(async () => ({
            ...EMPTY_META, favorites: ['/lib/kept.jpg'], tagNames: ['beach'],
        }));
        const { result } = mount(['/lib'], 'memory');
        await waitFor(() => expect(result.current.favorites.has('/lib/kept.jpg')).toBe(true));
        expect(result.current.tagNames).toEqual(['beach']);
        expect(saves).toEqual([]);
    });

    it('does not write anything back just for having loaded', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.tagNames).toEqual([]));
        await new Promise(r => setTimeout(r, 1000));
        expect(saves).toEqual([]);
    });

    /**
     * The load replaces the whole state when it lands. A heart press made
     * while it was still in flight used to vanish without a trace — and the
     * load globs the entire library, so on a network volume that window is
     * wide enough to hit.
     */
    it('keeps an edit made while the load was still in flight', async () => {
        let release: (meta: LibraryMeta) => void = () => {};
        (globalThis as any).window.api.libraryLoad = vi.fn(() => new Promise(r => { release = r; }));

        const { result } = mount();
        act(() => { result.current.setFavorite(['/lib/early.jpg'], true); });
        expect(result.current.favorites.has('/lib/early.jpg')).toBe(true);

        await act(async () => {
            release({ ...EMPTY_META, favorites: ['/lib/stored.jpg'], tagNames: ['beach'] });
            await Promise.resolve();
        });

        await waitFor(() => expect(result.current.favorites.has('/lib/stored.jpg')).toBe(true));
        expect(result.current.favorites.has('/lib/early.jpg')).toBe(true);
        expect(result.current.tagNames).toEqual(['beach']);
    });
});

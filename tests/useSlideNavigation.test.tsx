// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeQueued, useSlideNavigation } from '../src/hooks/useSlideNavigation';

const file = (name: string) => ({ name, path: `/lib/${name}`, type: 'image' as const });
const library = ['a.jpg', 'b.jpg', 'c.jpg'].map(file);

/** The `remote:queue` listener the hook registers, so a test can fire it. */
let queueListener: ((event: unknown, index: number) => void) | null;

beforeEach(() => {
    queueListener = null;
    (globalThis as any).window.api = {
        on: vi.fn((channel: string, cb: (event: unknown, index: number) => void) => {
            if (channel === 'remote:queue') queueListener = cb;
            return () => { if (channel === 'remote:queue') queueListener = null; };
        }),
    };
});

afterEach(() => cleanup());

interface Harness {
    files?: MediaFile[];
    isShuffle?: boolean;
    shuffleKey?: string | null;
    cullingMode?: boolean;
    viewed?: string[];
}

const mount = (options: Harness = {}) => {
    const calls = {
        goTo: [] as (number | ((p: number) => number))[],
        replaced: [] as MediaFile[][],
        cycles: [] as string[],
        cleared: [] as { key: string; total: number }[],
        queued: [] as MediaFile[],
    };
    const shuffle = {
        viewedIn: () => options.viewed ?? [],
        startNewCycle: (key: string, items: MediaFile[]) => {
            calls.cycles.push(key);
            return [...items].reverse();
        },
        clearViewed: (key: string, total: number) => { calls.cleared.push({ key, total }); },
        forgetOrder: () => { },
    };
    // Stable, like the real ones: `goTo` comes from useSlidePosition and
    // `replaceFiles` from usePlayableList, both of which pin their identity
    // in their own tests. Inline arrows here would make the hook's callbacks
    // churn and the identity checks below meaningless.
    const goTo = (next: number | ((p: number) => number)) => { calls.goTo.push(next); };
    const replaceFiles = (next: MediaFile[]) => { calls.replaced.push(next); };
    const hook = renderHook((props: Harness) => useSlideNavigation({
        files: props.files ?? library,
        goTo,
        replaceFiles,
        isShuffle: props.isShuffle ?? false,
        shuffleKey: props.shuffleKey === undefined ? '/lib::both' : props.shuffleKey,
        shuffle,
        cullingMode: props.cullingMode ?? false,
        onQueued: f => calls.queued.push(f),
    }), { initialProps: options });
    return { ...hook, calls };
};

/** What `goTo(prev => …)` would resolve to from a given index. */
const resolve = (next: number | ((p: number) => number), from: number) =>
    typeof next === 'function' ? next(from) : next;

describe('takeQueued', () => {
    it('finds nothing in an empty queue', () => {
        expect(takeQueued([], library)).toEqual({ index: null, rest: [] });
    });

    it('pops the first pick and keeps the rest', () => {
        expect(takeQueued(['/lib/c.jpg', '/lib/a.jpg'], library))
            .toEqual({ index: 2, rest: ['/lib/a.jpg'] });
    });

    /**
     * The case worth having a pure function for: a guest queues a photo and
     * it is deleted, or filtered out, before its turn. Stopping at the stale
     * entry would wedge the queue; dropping the queue would lose the other
     * picks.
     */
    it('skips picks that have left the list', () => {
        expect(takeQueued(['/lib/gone.jpg', '/lib/b.jpg'], library))
            .toEqual({ index: 1, rest: [] });
    });

    it('empties the queue when nothing in it survives', () => {
        expect(takeQueued(['/lib/x.jpg', '/lib/y.jpg'], library))
            .toEqual({ index: null, rest: [] });
    });
});

describe('moving through the show', () => {
    it('advances, and wraps at the end', () => {
        const { result, calls } = mount();
        act(() => result.current.nextSlide());
        expect(resolve(calls.goTo[0], 0)).toBe(1);
        expect(resolve(calls.goTo[0], 2)).toBe(0);
    });

    it('goes back, and wraps at the start', () => {
        const { result, calls } = mount();
        act(() => result.current.prevSlide());
        expect(resolve(calls.goTo[0], 0)).toBe(2);
        expect(resolve(calls.goTo[0], 1)).toBe(0);
    });

    it('carries the direction the transitions mirror on', () => {
        const { result } = mount();
        expect(result.current.direction).toBe(1);
        act(() => result.current.prevSlide());
        expect(result.current.direction).toBe(-1);
        act(() => result.current.nextSlide());
        expect(result.current.direction).toBe(1);
    });

    it('moves nowhere with an empty list, but still faces forwards', () => {
        const { result, calls } = mount({ files: [] });
        act(() => result.current.nextSlide());
        expect(calls.goTo).toEqual([]);
        expect(result.current.direction).toBe(1);
    });

    it('holds the position rather than dividing by zero going back', () => {
        const { result, calls } = mount({ files: [] });
        act(() => result.current.prevSlide());
        expect(resolve(calls.goTo[0], 4)).toBe(4);
    });

    it('jumps to a slide picked in the grid, facing the way it travelled', () => {
        const { result, calls } = mount();
        act(() => result.current.jumpTo(2, 0));
        expect(calls.goTo).toEqual([2]);
        expect(result.current.direction).toBe(1);
        act(() => result.current.jumpTo(0, 2));
        expect(result.current.direction).toBe(-1);
    });
});

describe('playing', () => {
    it('toggles', () => {
        const { result } = mount();
        expect(result.current.isPlaying).toBe(false);
        act(() => result.current.togglePlay());
        expect(result.current.isPlaying).toBe(true);
        act(() => result.current.togglePlay());
        expect(result.current.isPlaying).toBe(false);
    });

    /** Culling is a paused review; nothing may start the show while it is on. */
    it('refuses to start while culling', () => {
        const { result } = mount({ cullingMode: true });
        act(() => result.current.togglePlay());
        expect(result.current.isPlaying).toBe(false);
    });

    it('stops a running show when culling is turned on', () => {
        const { result, rerender } = mount();
        act(() => result.current.togglePlay());
        expect(result.current.isPlaying).toBe(true);
        act(() => rerender({ cullingMode: true }));
        expect(result.current.isPlaying).toBe(false);
    });
});

describe('a guest queue', () => {
    it('takes a pick by index and reports it by file', () => {
        const { result, calls } = mount();
        act(() => queueListener!(null, 2));
        expect(calls.queued.map(f => f.name)).toEqual(['c.jpg']);
        expect(result.current.queuedCount).toBe(1);
    });

    it('ignores an index that is not in the list', () => {
        const { result, calls } = mount();
        act(() => queueListener!(null, 99));
        expect(calls.queued).toEqual([]);
        expect(result.current.queuedCount).toBe(0);
    });

    /** The whole point: someone picks a photo and it comes up next. */
    it('jumps the line on the next advance, ahead of ordinary order', () => {
        const { result, calls } = mount();
        act(() => queueListener!(null, 2));
        act(() => result.current.nextSlide());
        expect(calls.goTo).toEqual([2]);
        expect(result.current.queuedCount).toBe(0);
    });

    it('serves picks in the order they were made', () => {
        const { result, calls } = mount();
        act(() => { queueListener!(null, 2); queueListener!(null, 1); });
        expect(result.current.queuedCount).toBe(2);
        act(() => result.current.nextSlide());
        act(() => result.current.nextSlide());
        expect(calls.goTo).toEqual([2, 1]);
    });

    /**
     * A pick is held as a path, not an index, so a delete or a re-sort
     * between the pick and its turn cannot land on the wrong photo.
     */
    it('follows its photo when the list is re-ordered', () => {
        const { result, calls, rerender } = mount();
        act(() => queueListener!(null, 2)); // c.jpg, last
        act(() => rerender({ files: [...library].reverse() })); // c.jpg, first
        act(() => result.current.nextSlide());
        expect(calls.goTo).toEqual([0]);
    });

    it('takes a guest pick ahead of starting a new shuffle cycle', () => {
        const viewed = library.map(f => f.path); // everything seen
        const { result, calls } = mount({ isShuffle: true, viewed });
        act(() => queueListener!(null, 1));
        act(() => result.current.nextSlide());
        expect(calls.goTo).toEqual([1]);
        expect(calls.cycles).toEqual([]);
    });
});

describe('the end of a shuffle cycle', () => {
    it('starts a new one once everything has been seen', () => {
        const viewed = library.map(f => f.path);
        const { result, calls } = mount({ isShuffle: true, viewed });
        act(() => result.current.nextSlide());
        expect(calls.cycles).toEqual(['/lib::both']);
        expect(calls.replaced[0].map(f => f.name)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
        expect(calls.goTo).toEqual([0]);
    });

    /**
     * It ends when everything has been seen, not when the index happens to be
     * the last one: keying off position meant wrapping backwards from slide 1
     * landed on the last slide, and the next press reshuffled the library.
     */
    it('does not start one mid-cycle, wherever the viewer is', () => {
        const { result, calls } = mount({ isShuffle: true, viewed: ['/lib/a.jpg'] });
        act(() => result.current.nextSlide());
        expect(calls.cycles).toEqual([]);
        expect(resolve(calls.goTo[0], 2)).toBe(0); // wrapped, same cycle
    });

    it('leaves the order alone when shuffle is off, however much has been seen', () => {
        const viewed = library.map(f => f.path);
        const { result, calls } = mount({ isShuffle: false, viewed });
        act(() => result.current.nextSlide());
        expect(calls.cycles).toEqual([]);
        expect(calls.replaced).toEqual([]);
    });
});

describe('resetting the history', () => {
    it('mints a new order and goes to its start under shuffle', () => {
        const { result, calls } = mount({ isShuffle: true });
        let reported = false;
        act(() => { reported = result.current.resetHistory(); });
        expect(reported).toBe(true);
        expect(calls.cycles).toEqual(['/lib::both']);
        expect(calls.goTo).toEqual([0]);
    });

    it('only clears what has been seen when shuffle is off', () => {
        const { result, calls } = mount({ isShuffle: false });
        act(() => { result.current.resetHistory(); });
        expect(calls.cleared).toEqual([{ key: '/lib::both', total: 3 }]);
        expect(calls.goTo).toEqual([]);
    });

    /**
     * No folders open means no key, and reporting a reset that did not happen
     * would put a toast on screen for nothing.
     */
    it('reports that it did nothing with no library open', () => {
        const { result, calls } = mount({ shuffleKey: null });
        let reported = true;
        act(() => { reported = result.current.resetHistory(); });
        expect(reported).toBe(false);
        expect(calls.cycles).toEqual([]);
        expect(calls.cleared).toEqual([]);
    });
});

/**
 * App names these callbacks in the dependency arrays of the effects that own
 * the keydown handler and the `menu:action` IPC listeners, and a playing
 * video re-renders about four times a second. An unstable callback tore those
 * listeners down and re-registered them at that rate — measured at 21
 * registrations over 5s before the other engine hooks were memoized.
 */
describe('identity', () => {
    it('keeps the callbacks stable across an unrelated re-render', () => {
        const { result, rerender } = mount();
        const before = result.current;
        act(() => rerender({}));
        expect(result.current.nextSlide).toBe(before.nextSlide);
        expect(result.current.prevSlide).toBe(before.prevSlide);
        expect(result.current.togglePlay).toBe(before.togglePlay);
        expect(result.current.jumpTo).toBe(before.jumpTo);
        expect(result.current).toBe(before);
    });

    /** A slide change must not churn them either — that is the frequent case. */
    it('keeps jumpTo stable when the viewer moves', () => {
        const { result } = mount();
        const before = result.current.jumpTo;
        act(() => result.current.jumpTo(2, 0));
        expect(result.current.jumpTo).toBe(before);
    });

    it('registers the queue listener once, not per list change', () => {
        const { rerender } = mount();
        act(() => rerender({ files: [...library].reverse() }));
        act(() => rerender({ files: library.slice(0, 2) }));
        const registrations = (window.api.on as any).mock.calls
            .filter(([channel]: [string]) => channel === 'remote:queue');
        expect(registrations).toHaveLength(1);
    });
});

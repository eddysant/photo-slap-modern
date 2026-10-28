// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayableList } from '../src/hooks/usePlayableList';
import { useShuffleCycle } from '../src/hooks/useShuffleCycle';

/**
 * The derive, not the ordering maths.
 *
 * `sortPlayable`, `applyLibraryFilters`, `resolvePosition` and the shuffle
 * order are pure and tested on their own. What only exists here is the
 * effect: what re-runs it and what must not, that a slow date lookup landing
 * after the settings changed is discarded, and that the position is resolved
 * in the same batch as the list rather than a render later.
 */

const file = (name: string, type: 'image' | 'video' = 'image'): MediaFile =>
    ({ name, path: `/lib/${name}`, type });
const four = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(n => file(n));

let getDates: ReturnType<typeof vi.fn>;
let toasts: string[];

beforeEach(() => {
    toasts = [];
    getDates = vi.fn(async (paths: string[]) =>
        Object.fromEntries(paths.map((p, i) => [p, 1000 - i])));
    (globalThis as any).window.api = {
        getStore: vi.fn(async () => null),
        setStore: vi.fn(),
        getDates,
    };
});

afterEach(cleanup);

interface Props {
    allFiles?: MediaFile[];
    currentDirs?: string[];
    mediaFilter?: string;
    sortOrder?: string;
    isShuffle?: boolean;
    favoritesOnly?: boolean;
    tagFilter?: string;
    favorites?: Set<string>;
    fileTags?: Record<string, string[]>;
}

// Stable defaults: `currentDirs` and `showToast` are dependencies of the
// derive, and a fresh one per render re-derives forever. In the app they come
// from state and from `useToast`, both stable.
const LIB = ['/lib'];
const NO_FAVORITES = new Set<string>();
const NO_TAGS: Record<string, string[]> = {};
const pushToast = (m: string) => { toasts.push(m); };

/** The real shuffle cycle, so the derive is wired as it is in the app. */
const mount = async (initial: Props = {}) => {
    const hook = renderHook((props: Props) => {
        const shuffle = useShuffleCycle();
        return {
            shuffle,
            list: usePlayableList({
                allFiles: props.allFiles ?? four,
                currentDirs: props.currentDirs ?? LIB,
                mediaFilter: props.mediaFilter ?? 'all',
                sortOrder: props.sortOrder ?? 'name',
                isShuffle: props.isShuffle ?? false,
                favoritesOnly: props.favoritesOnly ?? false,
                tagFilter: props.tagFilter ?? '',
                favorites: props.favorites ?? NO_FAVORITES,
                fileTags: props.fileTags ?? NO_TAGS,
                shuffle,
                showToast: pushToast,
            }),
        };
    }, { initialProps: initial });
    await waitFor(() => expect(hook.result.current.shuffle.ready).toBe(true));
    return hook;
};

const names = (hook: { result: { current: { list: { files: MediaFile[] } } } }) =>
    hook.result.current.list.files.map(f => f.name);

describe('usePlayableList', () => {
    it('derives the playable list from the scanned files', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']));
    });

    it('applies the media filter', async () => {
        const hook = await mount({ allFiles: [file('a.jpg'), file('b.mp4', 'video')] });
        hook.rerender({ allFiles: [file('a.jpg'), file('b.mp4', 'video')], mediaFilter: 'videos' });
        await waitFor(() => expect(names(hook)).toEqual(['b.mp4']));
    });

    // Deleting the last file used to leave it on screen: the derive bailed
    // out and `files` kept the stale list.
    it('empties the list when the source empties', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        hook.rerender({ allFiles: [] });
        await waitFor(() => expect(names(hook)).toEqual([]));
        expect(hook.result.current.list.position.index).toBe(0);
    });

    it('toasts when the filters match nothing', async () => {
        const hook = await mount();
        hook.rerender({ favoritesOnly: true });
        await waitFor(() => expect(toasts).toContain('No files match the filters'));
        expect(names(hook)).toEqual([]);
    });
});

describe('what re-derives the list, and what must not', () => {
    // A heart press re-deriving the list would reset the slide index.
    it('ignores a change to the favorites set while no filter uses it', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        const before = hook.result.current.list.files;
        hook.rerender({ favorites: new Set(['/lib/a.jpg']) });
        expect(hook.result.current.list.files).toBe(before);
    });

    it('re-derives when the favorites filter is switched on', async () => {
        const favorites = new Set(['/lib/c.jpg']);
        const hook = await mount({ favorites });
        hook.rerender({ favorites, favoritesOnly: true });
        await waitFor(() => expect(names(hook)).toEqual(['c.jpg']));
    });

    it('filters against the favorites as they are now, not as they were', async () => {
        const hook = await mount();
        hook.rerender({ favorites: new Set(['/lib/b.jpg']) });
        hook.rerender({ favorites: new Set(['/lib/b.jpg']), favoritesOnly: true });
        await waitFor(() => expect(names(hook)).toEqual(['b.jpg']));
    });

    it('re-derives when a tag filter is applied', async () => {
        const fileTags = { '/lib/a.jpg': ['trip'], '/lib/d.jpg': ['trip'] };
        const hook = await mount({ fileTags });
        hook.rerender({ fileTags, tagFilter: 'trip' });
        await waitFor(() => expect(names(hook)).toEqual(['a.jpg', 'd.jpg']));
    });

    it('does not re-derive on a render that changes nothing', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        const before = hook.result.current.list.files;
        hook.rerender({});
        hook.rerender({});
        expect(hook.result.current.list.files).toBe(before);
    });
});

describe('the date lookup', () => {
    it('is skipped for a name sort', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        expect(getDates).not.toHaveBeenCalled();
    });

    it('runs for a date sort', async () => {
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(1));
        expect(names(hook)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    });

    // Reading dates means the first 256 KB of every file in the library, and
    // shuffle discards the order it produces.
    it('is skipped under shuffle even with a date sort', async () => {
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc', isShuffle: true });
        await waitFor(() => expect(hook.result.current.list.files).toHaveLength(4));
        expect(getDates).not.toHaveBeenCalled();
    });

    it('asks only about files it has not asked about before', async () => {
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(1));
        hook.rerender({ sortOrder: 'date-desc', allFiles: [...four, file('e.jpg')] });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(2));
        expect(getDates.mock.calls[1][0]).toEqual(['/lib/e.jpg']);
    });

    // Keying off what came back instead would re-ask about every file the
    // EXIF reader cannot date, on every re-derive.
    it('does not re-ask about a file that came back undated', async () => {
        getDates.mockResolvedValue({});
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(1));
        hook.rerender({ sortOrder: 'date-asc' });
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        expect(getDates).toHaveBeenCalledTimes(1);
    });

    it('asks again after the cache is reset for a new folder', async () => {
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(1));
        act(() => { hook.result.current.list.resetDateCache(); });
        hook.rerender({ sortOrder: 'date-asc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(2));
        expect(getDates.mock.calls[1][0]).toHaveLength(4);
    });

    it('announces the wait the first time only', async () => {
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(toasts).toContain('Reading photo dates…'));
        hook.rerender({ sortOrder: 'date-asc' });
        await waitFor(() => expect(names(hook)).toEqual(['d.jpg', 'c.jpg', 'b.jpg', 'a.jpg']));
        expect(toasts.filter(t => t === 'Reading photo dates…')).toHaveLength(1);
    });

    // The lookup is awaited, so the settings can change underneath it.
    it('discards a lookup that lands after the settings moved on', async () => {
        let release: (v: Record<string, number>) => void = () => { };
        getDates.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const hook = await mount();
        hook.rerender({ sortOrder: 'date-desc' });
        await waitFor(() => expect(getDates).toHaveBeenCalledTimes(1));
        hook.rerender({ sortOrder: 'name' });
        await waitFor(() => expect(names(hook)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']));
        await act(async () => {
            release({ '/lib/a.jpg': 1, '/lib/b.jpg': 2, '/lib/c.jpg': 3, '/lib/d.jpg': 4 });
        });
        expect(names(hook)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    });
});

describe('the slide position', () => {
    it('lands on the pinned file in the same batch as the new list', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        act(() => { hook.result.current.list.position.pinPath('/lib/c.jpg'); });
        hook.rerender({ allFiles: four.filter(f => f.name !== 'a.jpg') });
        await waitFor(() => expect(names(hook)).toHaveLength(3));
        expect(hook.result.current.list.position.index).toBe(1);
    });

    // "Slide 1" is the one answer that is always wrong after a delete.
    it('keeps the place of a viewer whose file is removed', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        act(() => { hook.result.current.list.position.goTo(2) });
        act(() => { hook.result.current.list.position.pinSurvivorOf(['/lib/c.jpg']); });
        hook.rerender({ allFiles: four.filter(f => f.name !== 'c.jpg') });
        await waitFor(() => expect(names(hook)).toEqual(['a.jpg', 'b.jpg', 'd.jpg']));
        expect(hook.result.current.list.position.index).toBe(2);
    });

    it('starts a new folder at the beginning', async () => {
        const hook = await mount();
        act(() => { hook.result.current.list.position.goTo(3); });
        hook.rerender({ allFiles: [file('z.jpg')], currentDirs: ['/other'] });
        await waitFor(() => expect(names(hook)).toEqual(['z.jpg']));
        expect(hook.result.current.list.position.index).toBe(0);
    });
});

describe('identity', () => {
    it('is unchanged by a render that changes nothing', async () => {
        const hook = await mount();
        await waitFor(() => expect(names(hook)).toHaveLength(4));
        const before = hook.result.current.list;
        hook.rerender({});
        expect(hook.result.current.list).toBe(before);
    });
});

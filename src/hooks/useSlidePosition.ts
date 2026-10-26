import { useCallback, useEffect, useRef, useState } from 'react';
import { resolvePosition, survivingNeighbourPath, type PendingPosition } from '../playlist';

/**
 * Where the slideshow is, and where it should be once the playable list is
 * rebuilt underneath it.
 *
 * The list is re-derived constantly — every delete, undo, quick-move, guest
 * upload, watcher change, filter toggle and re-sort — and keeping the viewer
 * in place across that was spread over two refs, two effects and half a dozen
 * assignments scattered through `App`. Three separate "it jumped back to
 * slide 1" bugs came out of that, so it lives in one place now, with the
 * decision itself (`resolvePosition`) pure and unit-tested.
 *
 * The one rule: **nothing silently lands on slide 1**. A caller that wants
 * the beginning asks for it.
 */
export function useSlidePosition(files: readonly MediaFile[]) {
    const [index, setIndex] = useState(0);
    const pending = useRef<PendingPosition>(null);

    // A mirror, so `resolveFor` can stay referentially stable: it is called
    // from the derive, which is itself a dependency of the effect that owns
    // the playable list.
    const indexRef = useRef(index);
    const filesRef = useRef(files);
    useEffect(() => {
        indexRef.current = index;
        filesRef.current = files;
    }, [index, files]);

    /**
     * The index a freshly derived list should land on, consuming the request.
     *
     * The derive calls this and sets the index in the same batch as the list.
     * Resolving in an effect instead would render the new list against the
     * old index first, and the viewer would see the wrong slide for a frame.
     */
    const resolveFor = useCallback((list: readonly MediaFile[]) => {
        const wanted = pending.current;
        pending.current = null;
        return resolvePosition(wanted, list, indexRef.current);
    }, []);

    /** Jump now: navigation, a grid click, a guest's queued slide. */
    const goTo = useCallback((next: number | ((prev: number) => number)) => {
        setIndex(next);
    }, []);

    /** Land on this file once the list is rebuilt. `null` clears the request. */
    const pinPath = useCallback((path: string | null) => {
        pending.current = path === null ? null : { kind: 'path', path };
    }, []);

    /** Land on this index once the list is rebuilt — Resume, and new folders. */
    const pinIndex = useCallback((wanted: number) => {
        pending.current = { kind: 'index', index: wanted };
    }, []);

    /** Stay on the slide now showing, whatever the rebuild does to the list. */
    const hold = useCallback(() => {
        pinPath(filesRef.current[indexRef.current]?.path ?? null);
    }, [pinPath]);

    /**
     * Follow the nearest survivor of a removal: the next slide if there is
     * one, else the previous, so repeated deletes walk forward.
     */
    const pinSurvivorOf = useCallback((removed: Iterable<string>) => {
        pinPath(survivingNeighbourPath(filesRef.current, indexRef.current, new Set(removed)));
    }, [pinPath]);

    // Self-heal an index left past the end of a list that shrank without
    // going through the derive. Undefined at `files[index]` both killed the
    // advance timer and threw while rendering the slide.
    useEffect(() => {
        if (files.length > 0 && index > files.length - 1) setIndex(files.length - 1);
    }, [files, index]);

    // A safety net for the few places that set the list directly rather than
    // through the derive (a finished shuffle cycle, an explicit history
    // reset, un-favouriting under the favourites filter). A no-op whenever
    // `resolveFor` already consumed the request.
    useEffect(() => {
        if (files.length === 0 || pending.current === null) return;
        setIndex(resolvePosition(pending.current, files, indexRef.current));
        pending.current = null;
    }, [files]);

    return { index, goTo, pinPath, pinIndex, hold, pinSurvivorOf, resolveFor };
}

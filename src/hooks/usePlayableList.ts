import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyLibraryFilters, needsDateLookup, sortPlayable } from '../playlist';
import {
    getShuffleProgress, makeShuffleHistoryKey, orderForNoRepeatShuffle,
    reconcileShuffleOrder, retainShuffleOrder,
} from '../shuffleHistory';
import { useSlidePosition } from './useSlidePosition';
import type { useShuffleCycle } from './useShuffleCycle';

type ShuffleCycle = ReturnType<typeof useShuffleCycle>;

export interface PlayableListInputs {
    /** Everything the open folders hold, before any filter or order. */
    allFiles: MediaFile[];
    currentDirs: string[];
    mediaFilter: string;
    sortOrder: string;
    isShuffle: boolean;
    favoritesOnly: boolean;
    tagFilter: string;
    favorites: ReadonlySet<string>;
    fileTags: Readonly<Record<string, string[]>>;
    shuffle: ShuffleCycle;
    showToast: (message: string) => void;
}

/**
 * The playable list: what the slideshow actually draws from, derived from the
 * scanned files plus every setting that shapes an order.
 *
 * It is one effect because it has to be. Filters narrow, the sort orders,
 * shuffle replaces that order, and the slide position is resolved against the
 * result — all of which must land in a single `setFiles` batch, or the viewer
 * renders the new list against the old index for a frame. Splitting it into a
 * chain of effects is what produced the "it jumped back to slide 1" bugs.
 *
 * Everything the hook returns is referentially stable except `files` itself.
 */
export function usePlayableList({
    allFiles, currentDirs, mediaFilter, sortOrder, isShuffle,
    favoritesOnly, tagFilter, favorites, fileTags,
    shuffle, showToast,
}: PlayableListInputs) {
    const [files, setFiles] = useState<MediaFile[]>([]);

    // Where the viewer is, and where it should land once the list below is
    // rebuilt. It lives in here because the derive has to resolve the
    // position in the same batch it sets the list.
    const position = useSlidePosition(files);
    const { resolveFor, goTo } = position;

    // Favourite and tag EDITS must not re-derive the list — that would reset
    // the slide index on every heart press. The favourites/tag FILTERS are
    // real dependencies below; the sets they filter against are read through
    // refs so changing their contents alone changes nothing.
    const favoritesRef = useRef(favorites);
    const fileTagsRef = useRef(fileTags);
    useEffect(() => {
        favoritesRef.current = favorites;
        fileTagsRef.current = fileTags;
    }, [favorites, fileTags]);

    // Date-taken lookup, fetched lazily the first time a date sort is used
    // and cached until a different folder is opened.
    const fileDatesRef = useRef<Record<string, number> | null>(null);
    // Paths already asked about, whether or not a date came back. Keying off
    // the result instead would re-request every file the EXIF reader can't
    // date, on every re-derive.
    const datesRequestedRef = useRef<Set<string>>(new Set());

    const resetDateCache = useCallback(() => {
        fileDatesRef.current = null;
        datesRequestedRef.current = new Set();
    }, []);

    const ensureDates = useCallback(async (fileList: MediaFile[]) => {
        const requested = datesRequestedRef.current;
        // Only the paths we haven't asked about: files can join the list after
        // the first fetch (a guest upload, the folder watcher), and leaving
        // them undated sorted them all to one end of a date sort.
        const missing = fileList.map(f => f.path).filter(p => !requested.has(p));
        if (fileDatesRef.current && missing.length === 0) return fileDatesRef.current;
        if (!fileDatesRef.current) showToast('Reading photo dates…');
        for (const p of missing) requested.add(p);
        const fetched = missing.length > 0 ? await window.api.getDates(missing) : {};
        fileDatesRef.current = { ...(fileDatesRef.current ?? {}), ...fetched };
        return fileDatesRef.current;
    }, [showToast]);

    // Named individually rather than through `shuffle`, whose identity changes
    // as progress does: the derive must not re-run once per slide.
    const {
        viewedIn, orderIn, seedFor, setProgress, setViewed, rememberOrder,
    } = shuffle;

    const applyFiltersAndSort = useCallback((
        unfiltered: readonly MediaFile[],
        currentFilter: string,
        isShuffled: boolean,
        sort: string,
        dates: Record<string, number> | null,
        shuffleKey: string,
    ) => {
        const sorted = sortPlayable(unfiltered, currentFilter, sort, dates);

        if (isShuffled) {
            const previousHistory = viewedIn(shuffleKey);
            const established = orderIn(shuffleKey);
            if (established) {
                // Mid-cycle re-derive (a delete, a guest upload): keep the
                // running order rather than re-partitioning the user's
                // position away.
                sorted.splice(0, sorted.length, ...reconcileShuffleOrder(sorted, established, seedFor(shuffleKey)));
                setProgress(getShuffleProgress(sorted, previousHistory));
            } else {
                const ordered = orderForNoRepeatShuffle(sorted, previousHistory, seedFor(shuffleKey));
                sorted.splice(0, sorted.length, ...ordered.items);
                setProgress(getShuffleProgress(sorted, ordered.viewedPaths));
                if (ordered.cycleReset || ordered.viewedPaths.length !== previousHistory.length) {
                    setViewed(shuffleKey, ordered.viewedPaths);
                }
                // A finished cycle earns a new order; without a new seed the
                // next pass would replay the previous one exactly.
                if (ordered.cycleReset) seedFor(shuffleKey, true);
            }
            // Keep paths that have dropped out of the list, at their
            // positions: a photo that comes back (an undone delete, one that
            // could not be trashed) must return to where it was rather than
            // being treated as new media and sent to the front, dragging the
            // viewer to slide 1.
            rememberOrder(shuffleKey, retainShuffleOrder(established ?? [], sorted.map(file => file.path)));
        } else {
            setProgress({ viewed: 0, total: sorted.length });
        }

        setFiles(sorted);
        // Same batch as the list, so the viewer never sees the new list
        // against the old index.
        goTo(resolveFor(sorted));
    }, [viewedIn, orderIn, seedFor, setProgress, setViewed, rememberOrder, resolveFor, goTo]);

    const shuffleReady = shuffle.ready;

    useEffect(() => {
        if (allFiles.length === 0) {
            // Deleting the last file used to leave it on screen: the derive
            // bailed out here and `files` kept the stale list.
            setFiles([]);
            goTo(0);
            return;
        }
        // Ordering before the saved history has loaded would mint a cycle
        // against an empty one and throw away what had been seen.
        if (isShuffle && !shuffleReady) return;
        let cancelled = false;
        (async () => {
            const source = applyLibraryFilters<MediaFile>(allFiles, {
                favoritesOnly,
                favorites: favoritesRef.current,
                tagFilter,
                fileTags: fileTagsRef.current,
            });
            if (source.length === 0) {
                showToast(favoritesOnly || tagFilter ? 'No files match the filters' : 'No media files');
            }
            const dates = needsDateLookup(sortOrder, isShuffle) ? await ensureDates(allFiles) : null;
            const shuffleKey = makeShuffleHistoryKey(currentDirs, mediaFilter);
            if (!cancelled) applyFiltersAndSort(source, mediaFilter, isShuffle, sortOrder, dates, shuffleKey);
        })();
        return () => { cancelled = true; };
    }, [
        allFiles, mediaFilter, isShuffle, sortOrder, favoritesOnly, tagFilter,
        currentDirs, shuffleReady, ensureDates, applyFiltersAndSort, goTo, showToast,
    ]);

    /**
     * Replace the list directly, for the few changes that are not a re-derive:
     * a finished shuffle cycle, an explicit history reset, and un-favouriting
     * the current slide while the favourites filter is on.
     */
    const replaceFiles = useCallback((next: MediaFile[]) => setFiles(next), []);

    return useMemo(
        () => ({ files, position, replaceFiles, resetDateCache }),
        [files, position, replaceFiles, resetDateCache],
    );
}

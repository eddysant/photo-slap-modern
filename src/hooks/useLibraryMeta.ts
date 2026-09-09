import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Favorites, tags, ratings and culling decisions — the metadata that lives in
 * `.photo-slap.json` sidecars beside the photos rather than in app storage.
 *
 * Loads whenever the opened folders change and writes back on a debounce.
 * Every mutation goes through here so the sidecar save can never be forgotten,
 * which is what used to leave orphaned entries behind after a delete.
 */

export interface LibraryMetaState {
    favorites: Set<string>;
    fileTags: Record<string, string[]>;
    tagNames: string[];
    ratings: Record<string, number>;
    cullingDecisions: Record<string, CullingDecision>;
}

const EMPTY: LibraryMetaState = {
    favorites: new Set(),
    fileTags: {},
    tagNames: [],
    ratings: {},
    cullingDecisions: {},
};

const SAVE_DEBOUNCE_MS = 800;

/** Drop every entry for `paths` across all four metadata maps. */
export function pruneMetadata(state: LibraryMetaState, paths: Iterable<string>): LibraryMetaState {
    const gone = new Set(paths);
    if (gone.size === 0) return state;

    const favorites = new Set([...state.favorites].filter(p => !gone.has(p)));
    const omit = <T,>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).filter(([p]) => !gone.has(p)));

    const next: LibraryMetaState = {
        favorites,
        fileTags: omit(state.fileTags),
        ratings: omit(state.ratings),
        cullingDecisions: omit(state.cullingDecisions),
        // The tag vocabulary is the library's, not the file's — deleting a
        // photo must not retire a tag the user still wants to apply.
        tagNames: state.tagNames,
    };

    const unchanged =
        favorites.size === state.favorites.size &&
        Object.keys(next.fileTags).length === Object.keys(state.fileTags).length &&
        Object.keys(next.ratings).length === Object.keys(state.ratings).length &&
        Object.keys(next.cullingDecisions).length === Object.keys(state.cullingDecisions).length;

    return unchanged ? state : next;
}

/** Add or remove one tag on one path, dropping the key when it empties. */
export function toggleTag(
    fileTags: Record<string, string[]>,
    filePath: string,
    tag: string,
): Record<string, string[]> {
    const current = fileTags[filePath] ?? [];
    const next = { ...fileTags };
    const updated = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
    if (updated.length === 0) delete next[filePath];
    else next[filePath] = updated;
    return next;
}

export function useLibraryMeta(currentDirs: string[]) {
    const [state, setState] = useState<LibraryMetaState>(EMPTY);

    // Mirror of the latest state. Mutations compute the next value from this
    // ref and then set it, so no updater ever runs a side effect — StrictMode
    // double-invokes updaters, and an impure one here would double-save.
    const stateRef = useRef(state);

    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Latest roots, so a debounced save that lands after a folder change
    // still writes to the folders it was queued for.
    const dirsRef = useRef(currentDirs);
    useEffect(() => { dirsRef.current = currentDirs; }, [currentDirs]);

    const commit = useCallback((next: LibraryMetaState) => {
        stateRef.current = next;
        setState(next);
    }, []);

    // Load from the sidecars whenever the opened folders change
    useEffect(() => {
        if (currentDirs.length === 0) return;
        let cancelled = false;
        window.api.libraryLoad(currentDirs)
            .then(meta => {
                if (cancelled) return;
                commit({
                    favorites: new Set(meta.favorites),
                    fileTags: meta.tags,
                    tagNames: meta.tagNames,
                    ratings: meta.ratings,
                    cullingDecisions: meta.culling,
                });
            })
            .catch(e => console.error('Failed to load library metadata:', e));
        return () => { cancelled = true; };
    }, [currentDirs, commit]);

    const scheduleSave = useCallback((next: LibraryMetaState) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            const dirs = dirsRef.current;
            if (dirs.length === 0) return;
            window.api.librarySave(dirs, {
                favorites: [...next.favorites],
                tags: next.fileTags,
                tagNames: next.tagNames,
                ratings: next.ratings,
                culling: next.cullingDecisions,
            }).catch(e => console.error('Failed to save library metadata:', e));
        }, SAVE_DEBOUNCE_MS);
    }, []);

    useEffect(() => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
    }, []);

    /** Apply a pure update to the current state and persist the result. */
    const apply = useCallback((updater: (prev: LibraryMetaState) => LibraryMetaState) => {
        const prev = stateRef.current;
        const next = updater(prev);
        if (next === prev) return prev;
        commit(next);
        scheduleSave(next);
        return next;
    }, [commit, scheduleSave]);

    const setFavorite = useCallback((paths: string[], favorite: boolean) => {
        apply(prev => {
            const favorites = new Set(prev.favorites);
            paths.forEach(p => favorite ? favorites.add(p) : favorites.delete(p));
            return { ...prev, favorites };
        });
    }, [apply]);

    /** Flip one file's favorite flag; returns the flag's new value. */
    const toggleFavoriteAt = useCallback((filePath: string): boolean => {
        const nowFavorite = !stateRef.current.favorites.has(filePath);
        setFavorite([filePath], nowFavorite);
        return nowFavorite;
    }, [setFavorite]);

    const setTag = useCallback((filePath: string, tag: string, ensureInVocabulary = false) => {
        apply(prev => ({
            ...prev,
            fileTags: toggleTag(prev.fileTags, filePath, tag),
            tagNames: ensureInVocabulary && !prev.tagNames.includes(tag)
                ? [...prev.tagNames, tag].sort()
                : prev.tagNames,
        }));
    }, [apply]);

    const addTagToAll = useCallback((paths: string[], tag: string) => {
        apply(prev => {
            const fileTags = { ...prev.fileTags };
            paths.forEach(p => {
                const current = fileTags[p] ?? [];
                if (!current.includes(tag)) fileTags[p] = [...current, tag];
            });
            return {
                ...prev,
                fileTags,
                tagNames: prev.tagNames.includes(tag) ? prev.tagNames : [...prev.tagNames, tag].sort(),
            };
        });
    }, [apply]);

    const setRating = useCallback((paths: string[], rating: number | null) => {
        apply(prev => {
            const ratings = { ...prev.ratings };
            paths.forEach(p => rating === null ? delete ratings[p] : ratings[p] = rating);
            return { ...prev, ratings };
        });
    }, [apply]);

    const setCulling = useCallback((paths: string[], decision: CullingDecision | null) => {
        apply(prev => {
            const cullingDecisions = { ...prev.cullingDecisions };
            paths.forEach(p => decision === null ? delete cullingDecisions[p] : cullingDecisions[p] = decision);
            return { ...prev, cullingDecisions };
        });
    }, [apply]);

    /**
     * Forget every trace of files that are gone, and persist it. Without this,
     * the sidecar keeps entries for paths that no longer exist and the library
     * health scan reports them as orphans later — the app manufacturing
     * exactly the mess its repair tool exists to clean up.
     */
    const forget = useCallback((paths: string[]) => {
        if (paths.length === 0) return;
        apply(prev => pruneMetadata(prev, paths));
    }, [apply]);

    /** Forget without persisting — the health repair already rewrote sidecars. */
    const forgetLocally = useCallback((paths: string[]) => {
        if (paths.length === 0) return;
        const prev = stateRef.current;
        const next = pruneMetadata(prev, paths);
        if (next !== prev) commit(next);
    }, [commit]);

    return {
        ...state,
        setFavorite,
        toggleFavoriteAt,
        setTag,
        addTagToAll,
        setRating,
        setCulling,
        forget,
        forgetLocally,
    };
}

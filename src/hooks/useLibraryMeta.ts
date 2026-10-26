import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Favorites, tags, ratings and culling decisions — the metadata that lives in
 * `.photo-slap.json` sidecars beside the photos rather than in app storage.
 *
 * Loads whenever the opened folders change and writes back on a debounce.
 * Every mutation goes through here so the sidecar save can never be forgotten,
 * which is what used to leave orphaned entries behind after a delete.
 *
 * Writing is optional: `storage: 'memory'` keeps everything for the session
 * and leaves the library untouched. Loading is not optional — reading a
 * sidecar that is already there costs the folder nothing, and a library that
 * has been tagged before should still show its tags.
 */

export interface LibraryMetaState {
    favorites: Set<string>;
    fileTags: Record<string, string[]>;
    tagNames: string[];
    ratings: Record<string, number>;
    cullingDecisions: Record<string, CullingDecision>;
}

/** Where favorites, tags, ratings and culling decisions are kept. */
export type MetadataStorage = 'sidecar' | 'memory';

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

/** The on-disk shape of the in-memory state. */
export function sidecarPayload(state: LibraryMetaState): LibraryMeta {
    return {
        favorites: [...state.favorites],
        tags: state.fileTags,
        tagNames: state.tagNames,
        ratings: state.ratings,
        culling: state.cullingDecisions,
    };
}

export type MetadataEvent =
    | { kind: 'edit' }
    | { kind: 'storage-changed'; from: MetadataStorage };

export type SidecarAction = 'schedule' | 'write-now' | 'cancel' | 'none';

/**
 * The whole write policy, in one pure function.
 *
 * Switching *to* sidecars writes immediately rather than waiting for the next
 * edit: the session's work is already in memory, and the obvious reading of
 * turning saving on is "save what I have". Switching *away* cancels, because
 * a debounced write that lands a moment after the user asked for no sidecars
 * is exactly the thing they asked not to happen.
 */
export function sidecarAction(event: MetadataEvent, storage: MetadataStorage): SidecarAction {
    if (event.kind === 'edit') return storage === 'sidecar' ? 'schedule' : 'none';
    if (event.from === storage) return 'none';
    return storage === 'sidecar' ? 'write-now' : 'cancel';
}

export interface SidecarSaver {
    /** Metadata changed. Schedules a write, or doesn't. */
    edit(state: LibraryMetaState): void;
    /** Where metadata should live from now on. */
    setStorage(storage: MetadataStorage, state: LibraryMetaState): void;
    /** Write anything still pending, now — the hook is going away. */
    flush(state: LibraryMetaState): void;
    cancel(): void;
    readonly storage: MetadataStorage;
    readonly pending: boolean;
}

/**
 * The debounced sidecar writer, separated from React so the policy it
 * implements can be tested against a clock instead of a rendered tree.
 *
 * It owns the current storage mode rather than reading it back from the
 * caller, so a queued write and the setting it depends on can never disagree.
 */
export function createSidecarSaver(
    write: (payload: LibraryMeta) => void,
    delayMs: number = SAVE_DEBOUNCE_MS,
    initialStorage: MetadataStorage = 'sidecar',
): SidecarSaver {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let storage = initialStorage;

    const cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };

    const writeNow = (state: LibraryMetaState) => {
        cancel();
        write(sidecarPayload(state));
    };

    return {
        edit(state) {
            if (sidecarAction({ kind: 'edit' }, storage) !== 'schedule') return;
            cancel();
            timer = setTimeout(() => {
                timer = null;
                write(sidecarPayload(state));
            }, delayMs);
        },
        setStorage(next, state) {
            const action = sidecarAction({ kind: 'storage-changed', from: storage }, next);
            storage = next;
            // A write queued a moment ago must not land in a folder the user
            // has just asked to leave alone.
            if (action === 'cancel') cancel();
            else if (action === 'write-now') writeNow(state);
        },
        flush(state) {
            // A timer can only exist in sidecar mode — switching away cancels
            // — so there is no mode to re-check here.
            if (!timer) return;
            writeNow(state);
        },
        cancel,
        get storage() { return storage; },
        get pending() { return timer !== null; },
    };
}

export function useLibraryMeta(currentDirs: string[], storage: MetadataStorage = 'sidecar') {
    const [state, setState] = useState<LibraryMetaState>(EMPTY);

    // Mirror of the latest state. Mutations compute the next value from this
    // ref and then set it, so no updater ever runs a side effect — StrictMode
    // double-invokes updaters, and an impure one here would double-save.
    const stateRef = useRef(state);

    // Latest roots, so a debounced save that lands after a folder change
    // still writes to the folders it was queued for.
    const dirsRef = useRef(currentDirs);
    useEffect(() => { dirsRef.current = currentDirs; }, [currentDirs]);

    // Built in an effect, not in render: it closes over refs, and nothing it
    // does is needed to produce a frame.
    const saverRef = useRef<SidecarSaver | null>(null);
    useEffect(() => {
        const saver = createSidecarSaver(payload => {
            const dirs = dirsRef.current;
            if (dirs.length === 0) return;
            window.api.librarySave(dirs, payload)
                .catch(e => console.error('Failed to save library metadata:', e));
        });
        saverRef.current = saver;
        // A save queued within the debounce of a quit used to be dropped on
        // the way out, silently losing the last heart press.
        return () => {
            saver.flush(stateRef.current);
            saverRef.current = null;
        };
    }, []);

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

    // Turning saving on writes what the session has; turning it off stops a
    // queued write from landing afterwards. Declared after the effect that
    // builds the saver, so it is there by the time this runs.
    useEffect(() => {
        saverRef.current?.setStorage(storage, stateRef.current);
    }, [storage]);

    /** Apply a pure update to the current state and persist the result. */
    const apply = useCallback((updater: (prev: LibraryMetaState) => LibraryMetaState) => {
        const prev = stateRef.current;
        const next = updater(prev);
        if (next === prev) return prev;
        commit(next);
        saverRef.current?.edit(next);
        return next;
    }, [commit]);

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

    // Memoized: a fresh object here changes identity on every render, which
    // makes every consumer callback that lists it as a dependency unstable.
    // In App that reached the effects owning the keydown handler and the
    // menu:action IPC listeners, so they tore down and re-registered several
    // times a second while a video played.
    return useMemo(() => ({
        ...state,
        setFavorite,
        toggleFavoriteAt,
        setTag,
        addTagToAll,
        setRating,
        setCulling,
        forget,
        forgetLocally,
    }), [state, setFavorite, toggleFavoriteAt, setTag, addTagToAll, setRating, setCulling, forget, forgetLocally]);
}

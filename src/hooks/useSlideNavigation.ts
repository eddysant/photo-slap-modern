import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasSeenEverything } from '../shuffleHistory';

/** 1 = forward, -1 = backward. Directional transitions mirror on -1. */
export type NavDirection = 1 | -1;

/**
 * Pop the next queued path that is still in the list.
 *
 * Pure, because the interesting case is the one that is easy to get wrong: a
 * guest queues a photo and it is deleted, or filtered out, before its turn.
 * Dropping the whole queue would lose the other picks; stopping at the first
 * stale entry would wedge it. Skipping is the only answer that keeps the
 * queue moving, and returning the remainder makes that testable.
 */
export function takeQueued(queue: string[], list: MediaFile[]): { index: number | null; rest: string[] } {
    let rest = queue;
    while (rest.length > 0) {
        const [path, ...tail] = rest;
        rest = tail;
        const index = list.findIndex(file => file.path === path);
        if (index >= 0) return { index, rest };
    }
    return { index: null, rest };
}

interface NavigationOptions {
    /** The playable list, in the order it is shown. */
    files: MediaFile[];
    /** From `useSlidePosition`: the only way to move the viewer. */
    goTo: (next: number | ((prev: number) => number)) => void;
    /** From `usePlayableList`: replaces the list outside the derive. */
    replaceFiles: (files: MediaFile[]) => void;
    isShuffle: boolean;
    /** The shuffle history/seed key for the open roots and media filter. */
    shuffleKey: string | null;
    shuffle: {
        viewedIn: (key: string) => string[];
        startNewCycle: (key: string, items: MediaFile[]) => MediaFile[];
        clearViewed: (key: string, total: number) => void;
        forgetOrder: () => void;
    };
    /** Culling is a paused review; nothing may start the show while it is on. */
    cullingMode: boolean;
    /** A guest queued a slide from their phone. */
    onQueued: (file: MediaFile) => void;
}

/**
 * Where the slideshow goes next, and whether it is going anywhere by itself.
 *
 * This is the half of the engine that was still loose in `App`: the
 * navigation direction, the guest queue, the play flag and the decision to
 * start a new shuffle cycle. `useSlidePosition` owns *where* the viewer is
 * and `usePlayableList` owns *what* it draws from; this owns the moves
 * between them, which is why all three of the "it jumped back to slide 1"
 * bugs were reachable from here.
 */
export function useSlideNavigation({
    files, goTo, replaceFiles, isShuffle, shuffleKey, shuffle, cullingMode, onQueued,
}: NavigationOptions) {
    const [direction, setDirection] = useState<NavDirection>(1);
    const [isPlaying, setIsPlaying] = useState(false);

    /**
     * Slides guests have queued from their phones, as paths. A queued slide
     * jumps the line on the next advance — automatic or manual — which is the
     * whole point: someone picks a photo and it comes up next.
     */
    const queueRef = useRef<string[]>([]);
    const [queuedCount, setQueuedCount] = useState(0);

    const onQueuedRef = useRef(onQueued);
    useEffect(() => { onQueuedRef.current = onQueued; }, [onQueued]);

    // The list is read through a ref so the queue listener is registered once
    // rather than on every re-derive; it only ever needs the current list.
    const filesRef = useRef(files);
    useEffect(() => { filesRef.current = files; }, [files]);

    useEffect(() => {
        return window.api.on('remote:queue', (_event, index: number) => {
            const file = filesRef.current[index];
            if (!file) return;
            queueRef.current = [...queueRef.current, file.path];
            setQueuedCount(queueRef.current.length);
            onQueuedRef.current(file);
        });
    }, []);

    const takeQueuedIndex = useCallback((list: MediaFile[]) => {
        const { index, rest } = takeQueued(queueRef.current, list);
        queueRef.current = rest;
        setQueuedCount(rest.length);
        return index;
    }, []);

    // NOTE: keep these updaters pure (no setState inside another setState
    // updater) — StrictMode double-invokes updaters and impure ones make
    // navigation skip slides in dev.
    const nextSlide = useCallback(() => {
        setDirection(1);
        if (files.length === 0) return;
        // Guest picks come first, ahead of shuffle and normal order alike.
        const queued = takeQueuedIndex(files);
        if (queued !== null) {
            goTo(queued);
            return;
        }
        // Start a new cycle only once everything really has been seen. Keying
        // off "we are on the last index" meant wrapping backwards from slide 1
        // landed on the last slide, and the next press then reshuffled the
        // whole library.
        if (isShuffle && shuffleKey) {
            if (hasSeenEverything(files, shuffle.viewedIn(shuffleKey))) {
                replaceFiles(shuffle.startNewCycle(shuffleKey, files));
                goTo(0);
                return;
            }
        }
        goTo(prev => (prev + 1) % files.length);
    }, [files, isShuffle, shuffleKey, shuffle, takeQueuedIndex, goTo, replaceFiles]);

    const prevSlide = useCallback(() => {
        setDirection(-1);
        goTo(prev => files.length === 0 ? prev : (prev - 1 + files.length) % files.length);
    }, [files.length, goTo]);

    /**
     * Jump straight to a slide — picked in the grid, or queued by a guest.
     *
     * `from` is passed in rather than read from a `currentIndex` option so
     * this callback stays referentially stable across slide changes: the
     * direction only decides which way the transition mirrors, and taking
     * the index as state would make every callback this hook returns churn
     * once a second while a video plays.
     */
    const jumpTo = useCallback((index: number, from: number) => {
        setDirection(index >= from ? 1 : -1);
        goTo(index);
    }, [goTo]);

    const togglePlay = useCallback(() => {
        if (!cullingMode) setIsPlaying(prev => !prev);
    }, [cullingMode]);

    // Culling is a review, not a show. Entering it stops playback however it
    // was entered — the setting, a preset, or the menu.
    useEffect(() => {
        if (cullingMode) setIsPlaying(false);
    }, [cullingMode]);

    /**
     * Forget what has been seen. Returns whether there was anything to do, so
     * the caller only reports a reset that happened.
     */
    const resetHistory = useCallback(() => {
        if (!shuffleKey) return false;
        if (isShuffle) {
            // An explicit reset should give a genuinely different order, not
            // the same one the finished cycle used.
            replaceFiles(shuffle.startNewCycle(shuffleKey, files));
            goTo(0);
        } else {
            shuffle.clearViewed(shuffleKey, files.length);
        }
        return true;
    }, [shuffleKey, isShuffle, shuffle, files, replaceFiles, goTo]);

    // Memoized for the same reason the other engine hooks are: the keydown
    // and `menu:action` effects name these callbacks, and a video playing
    // re-renders about four times a second.
    return useMemo(() => ({
        direction, isPlaying, setIsPlaying, queuedCount,
        nextSlide, prevSlide, jumpTo, togglePlay, resetHistory,
    }), [direction, isPlaying, queuedCount, nextSlide, prevSlide, jumpTo, togglePlay, resetHistory]);
}

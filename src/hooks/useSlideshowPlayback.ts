import { useCallback, useEffect, useRef } from 'react';

/**
 * A video that produces no `timeupdate` for this long is treated as stalled.
 * Long enough to cover a slow first decode off a network volume, short enough
 * that a party doesn't sit staring at a dead slide.
 */
export const VIDEO_STALL_TIMEOUT_MS = 15_000;

interface PlaybackOptions {
    isPlaying: boolean;
    /** The slide currently on screen, or null when there is none. */
    currentFile: MediaFile | null;
    /** Video paused by the user (click / pause overlay). */
    isUserPaused: boolean;
    slideDuration: number;
    onAdvance: () => void;
    onStalled: (file: MediaFile) => void;
}

/**
 * Owns "the show must keep moving".
 *
 * Images advance on a timer. Videos advance on their `ended` event — which is
 * the bug this hook exists to contain: `ended` never fires for a file
 * Chromium cannot decode (HEVC .mov straight off an iPhone is the common
 * case), for a truncated or corrupt file, or for one that was deleted from
 * disk while it sat queued. Any of those left the slideshow parked on that
 * slide forever, with `isPlaying` still true and no way forward but a manual
 * arrow press. A watchdog notices the lack of progress and skips on.
 *
 * Returns `notePlaybackProgress`, which the <video>'s onTimeUpdate must call
 * so a legitimately long video is never mistaken for a stalled one.
 */
export function useSlideshowPlayback({
    isPlaying,
    currentFile,
    isUserPaused,
    slideDuration,
    onAdvance,
    onStalled,
}: PlaybackOptions) {
    // Set on mount and on each slide change by the effect below; the
    // watchdog interval cannot fire before that has run.
    const lastProgressAt = useRef(0);

    const notePlaybackProgress = useCallback(() => {
        lastProgressAt.current = Date.now();
    }, []);

    const isVideo = currentFile?.type === 'video';
    const currentPath = currentFile?.path ?? null;

    // A new slide starts with a clean progress clock.
    useEffect(() => {
        lastProgressAt.current = Date.now();
    }, [currentPath]);

    // Images: plain interval.
    useEffect(() => {
        if (!isPlaying || !currentFile || currentFile.type !== 'image') return;
        const interval = setInterval(onAdvance, slideDuration);
        return () => clearInterval(interval);
    }, [isPlaying, currentFile, slideDuration, onAdvance]);

    // Videos: watchdog for the `ended` event that never comes.
    useEffect(() => {
        if (!isPlaying || !isVideo || isUserPaused || !currentFile) return;
        const check = setInterval(() => {
            if (Date.now() - lastProgressAt.current < VIDEO_STALL_TIMEOUT_MS) return;
            lastProgressAt.current = Date.now(); // don't re-fire while advancing
            onStalled(currentFile);
            onAdvance();
        }, 1_000);
        return () => clearInterval(check);
    }, [isPlaying, isVideo, isUserPaused, currentFile, onAdvance, onStalled]);

    return { notePlaybackProgress };
}

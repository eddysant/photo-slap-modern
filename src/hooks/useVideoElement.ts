import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Where a relative seek lands.
 *
 * Clamped at both ends, and deliberately short of the very end: seeking to
 * exactly `duration` fires `ended`, so M/N near the end of a clip would
 * advance the slideshow instead of scrubbing.
 */
export function seekTarget(currentTime: number, duration: number, delta: number): number | null {
    if (!isFinite(duration) || duration <= 0) return null;
    return Math.min(Math.max(0, currentTime + delta), Math.max(0, duration - 0.1));
}

/**
 * The scrubber's position, 0-100.
 *
 * A video reports `duration` as `NaN` until its metadata arrives and `0` for
 * a file it cannot read at all, and `0/0` is `NaN` — which React renders as a
 * blank slider rather than an empty one.
 */
export function progressPercent(currentTime: number, duration: number): number {
    if (!isFinite(duration) || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
}

/** Where a scrubber position lands in the clip. */
export function percentToTime(percent: number, duration: number): number | null {
    if (!isFinite(duration) || duration <= 0) return null;
    return (Math.min(100, Math.max(0, percent)) / 100) * duration;
}

interface VideoElementOptions {
    /**
     * The slide on screen. Everything here is keyed on its **path**, which is
     * also the React key of the slide wrapper — so a new path really is a new
     * `<video>` element, and a re-sort that leaves the same file on screen
     * leaves the playing video alone.
     */
    currentFile: MediaFile | null;
    volume: number;
    isMuted: boolean;
}

/**
 * The two `<video>` elements, and the single owner of play/pause/seek for both.
 *
 * The blurred background video deliberately has **no `autoPlay` attribute**:
 * if it had one, turning smart background on while the main video was paused
 * would start the blur playing behind a still frame. Playback is driven from
 * here instead, for both elements together, which is also what keeps a seek
 * from desynchronising them.
 *
 * Everything the slideshow does to a video goes through the returned
 * callbacks, so what this hook touches on an element is its whole contract:
 * `volume`, `muted`, `currentTime`, `duration`, `play()` and `pause()`. That
 * is a small enough surface for a test to stand in for a real element, which
 * is the point of having it out of `App` — none of this had unit coverage
 * while it was a handful of effects and raw refs in a 1,400-line component.
 */
export function useVideoElement({
    currentFile,
    volume,
    isMuted,
}: VideoElementOptions) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const bgVideoRef = useRef<HTMLVideoElement | null>(null);
    const [progress, setProgress] = useState(0);
    const [isUserPaused, setIsUserPaused] = useState(false);

    const path = currentFile?.path ?? null;

    // A new slide starts unpaused, at the beginning of the scrubber.
    useEffect(() => {
        setProgress(0);
        setIsUserPaused(false);
    }, [path]);

    // Read by the attach callbacks, which run when an element mounts rather
    // than when this value changes. A ref callback runs before effects in the
    // same commit, so on the one commit that both flips this and mounts an
    // element the attach sees the old value — and the effect below, which
    // runs immediately after, puts it right.
    const isUserPausedRef = useRef(isUserPaused);
    useEffect(() => { isUserPausedRef.current = isUserPaused; }, [isUserPaused]);

    /**
     * Bring an element in line with the current pause state.
     *
     * Applied when an element mounts as well as when the state changes,
     * because an element that mounts later has missed the change: the blurred
     * background video appears only when smart background is turned on, and
     * it is the one with no `autoPlay` attribute to fall back on. Driving it
     * on attach is what makes that correct without the hook having to watch
     * the two smart-background settings as a proxy for "something mounted".
     */
    const applyPlayState = (el: HTMLVideoElement) => {
        if (isUserPausedRef.current) el.pause();
        // `play()` is refused routinely — autoplay policy, a file that will
        // not decode — and returns nothing at all on some elements.
        else void Promise.resolve(el.play()).catch(() => { });
    };

    /**
     * Attach the main video. The volume is set here as well as in the effect
     * below because a newly mounted element starts at full volume, and the
     * effect runs a frame later — long enough to be heard.
     */
    const attachVideo = useCallback((el: HTMLVideoElement | null) => {
        videoRef.current = el;
        if (!el) return;
        el.volume = volume;
        el.muted = isMuted;
        applyPlayState(el);
    }, [volume, isMuted]);

    const attachBgVideo = useCallback((el: HTMLVideoElement | null) => {
        bgVideoRef.current = el;
        if (el) applyPlayState(el);
    }, []);

    useEffect(() => {
        const el = videoRef.current;
        if (!el) return;
        el.volume = volume;
        el.muted = isMuted;
    }, [volume, isMuted, path]);

    // Play/pause for both elements at once, whenever the state or the slide
    // changes. An element that mounts after this ran is handled on attach.
    useEffect(() => {
        for (const el of [videoRef.current, bgVideoRef.current]) {
            if (el) applyPlayState(el);
        }
    }, [isUserPaused, path]);

    const togglePause = useCallback(() => setIsUserPaused(prev => !prev), []);

    /**
     * Move the scrubber. Deliberately does **not** tell the stall watchdog
     * the video is alive: that is `useSlideshowPlayback`'s business, and the
     * `<video>` calls both. Keeping them separate is what lets this hook be
     * tested against nothing but an element.
     */
    const handleTimeUpdate = useCallback(() => {
        const el = videoRef.current;
        if (el) setProgress(progressPercent(el.currentTime, el.duration));
    }, []);

    /** Move both videos to the same time, and the scrubber with them. */
    const seekTo = useCallback((time: number, duration: number) => {
        const el = videoRef.current;
        if (!el) return;
        el.currentTime = time;
        if (bgVideoRef.current) bgVideoRef.current.currentTime = time;
        setProgress(progressPercent(time, duration));
    }, []);

    /** Scrubber dragged to a position, 0-100. */
    const seekToPercent = useCallback((percent: number) => {
        const el = videoRef.current;
        if (!el) return;
        const time = percentToTime(percent, el.duration);
        if (time === null) return;
        seekTo(time, el.duration);
    }, [seekTo]);

    /** M/N: jump by delta seconds. */
    const seekBy = useCallback((delta: number) => {
        const el = videoRef.current;
        if (!el) return;
        const time = seekTarget(el.currentTime, el.duration, delta);
        if (time === null) return;
        seekTo(time, el.duration);
    }, [seekTo]);

    // Memoized like every other engine hook, though the memo is not the
    // guarantee: `progress` changes several times a second while a clip
    // plays, so a consumer's dependency array must name the callback it uses
    // and never this object. `tests/App.deps.test.ts` keeps it honest.
    return useMemo(() => ({
        attachVideo, attachBgVideo,
        progress, isUserPaused, togglePause,
        handleTimeUpdate, seekToPercent, seekBy,
    }), [attachVideo, attachBgVideo, progress, isUserPaused, togglePause,
        handleTimeUpdate, seekToPercent, seekBy]);
}

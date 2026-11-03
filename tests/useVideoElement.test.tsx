// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    percentToTime, progressPercent, seekTarget, useVideoElement,
} from '../src/hooks/useVideoElement';

const clip = (name = 'a.mp4') => ({ name, path: `/lib/${name}`, type: 'video' as const });

/**
 * Everything the hook is allowed to touch on an element, and nothing else —
 * which is the point of having it out of `App`. jsdom's HTMLMediaElement
 * throws from `play()`, and a real element would answer `duration` with NaN
 * forever without a decoder, so a stand-in is the honest test subject here.
 */
const element = (duration = 100, currentTime = 0) => ({
    duration, currentTime, volume: 1, muted: false,
    plays: 0, pauses: 0,
    play() { this.plays++; return Promise.resolve(); },
    pause() { this.pauses++; },
});
type Stub = ReturnType<typeof element>;
const asVideo = (el: Stub) => el as unknown as HTMLVideoElement;

interface Harness {
    currentFile?: MediaFile | null;
    volume?: number;
    isMuted?: boolean;
}

const mount = (options: Harness = {}) => renderHook((props: Harness) => useVideoElement({
    currentFile: props.currentFile === undefined ? clip() : props.currentFile,
    volume: props.volume ?? 1,
    isMuted: props.isMuted ?? false,
}), { initialProps: options });

/** Mounted with both elements attached, as the JSX does. */
const mountAttached = (options: Harness = {}, main = element(), bg = element()) => {
    const hook = mount(options);
    act(() => {
        hook.result.current.attachVideo(asVideo(main));
        hook.result.current.attachBgVideo(asVideo(bg));
    });
    return { ...hook, main, bg };
};

afterEach(() => cleanup());

describe('seekTarget', () => {
    it('jumps forward and back by the delta', () => {
        expect(seekTarget(10, 100, 10)).toBe(20);
        expect(seekTarget(10, 100, -5)).toBe(5);
    });

    it('never goes before the start', () => {
        expect(seekTarget(3, 100, -10)).toBe(0);
    });

    /**
     * Seeking to exactly `duration` fires `ended`, so M near the end of a clip
     * would advance the slideshow instead of scrubbing it.
     */
    it('stops just short of the end rather than firing ended', () => {
        expect(seekTarget(95, 100, 10)).toBe(99.9);
    });

    it('declines to guess before the metadata arrives', () => {
        expect(seekTarget(0, NaN, 10)).toBeNull();
        expect(seekTarget(0, Infinity, 10)).toBeNull();
        expect(seekTarget(0, 0, 10)).toBeNull();
    });
});

describe('progressPercent', () => {
    it('reads as a percentage of the clip', () => {
        expect(progressPercent(0, 100)).toBe(0);
        expect(progressPercent(25, 100)).toBe(25);
        expect(progressPercent(100, 100)).toBe(100);
    });

    /**
     * A video reports `duration` as NaN until its metadata arrives and 0 for a
     * file it cannot read at all; `0/0` is NaN, which React renders as a blank
     * slider rather than an empty one.
     */
    it('is 0, never NaN, before a duration is known', () => {
        expect(progressPercent(0, NaN)).toBe(0);
        expect(progressPercent(0, 0)).toBe(0);
        expect(progressPercent(5, Infinity)).toBe(0);
    });

    it('cannot leave the scrubber', () => {
        expect(progressPercent(150, 100)).toBe(100);
        expect(progressPercent(-5, 100)).toBe(0);
    });
});

describe('percentToTime', () => {
    it('maps the scrubber onto the clip', () => {
        expect(percentToTime(50, 80)).toBe(40);
        expect(percentToTime(0, 80)).toBe(0);
    });

    it('clamps, and declines without a duration', () => {
        expect(percentToTime(120, 80)).toBe(80);
        expect(percentToTime(50, NaN)).toBeNull();
    });
});

describe('volume', () => {
    /**
     * Set on attach as well as in the effect: a newly mounted element starts
     * at full volume and the effect runs a frame later — long enough to be
     * heard, which is the whole complaint.
     */
    it('reaches a newly attached element immediately', () => {
        const { main } = mountAttached({ volume: 0.25, isMuted: true });
        expect(main.volume).toBe(0.25);
        expect(main.muted).toBe(true);
    });

    it('follows the setting while the clip plays', () => {
        const { main, rerender } = mountAttached({ volume: 1 });
        act(() => rerender({ volume: 0.5, isMuted: true }));
        expect(main.volume).toBe(0.5);
        expect(main.muted).toBe(true);
    });

    /** The blur is muted in the markup; nothing here should unmute it. */
    it('leaves the background video alone', () => {
        const { bg, rerender } = mountAttached({ volume: 1 });
        act(() => rerender({ volume: 0.5 }));
        expect(bg.volume).toBe(1);
    });
});

describe('play and pause', () => {
    it('starts both videos together', () => {
        const { main, bg } = mountAttached();
        expect(main.plays).toBeGreaterThan(0);
        expect(bg.plays).toBeGreaterThan(0);
    });

    it('pauses both when the user clicks', () => {
        const { result, main, bg } = mountAttached();
        act(() => result.current.togglePause());
        expect(result.current.isUserPaused).toBe(true);
        expect(main.pauses).toBe(1);
        expect(bg.pauses).toBe(1);
    });

    it('resumes both', () => {
        const { result, main, bg } = mountAttached();
        act(() => result.current.togglePause());
        const before = { main: main.plays, bg: bg.plays };
        act(() => result.current.togglePause());
        expect(main.plays).toBe(before.main + 1);
        expect(bg.plays).toBe(before.bg + 1);
    });

    /**
     * The reason the blurred video has no `autoPlay` attribute: with one,
     * turning smart background on while the main video was paused started the
     * blur playing behind a still frame.
     */
    it('does not start the blur while the main video is paused', () => {
        const { result } = mountAttached();
        act(() => result.current.togglePause());

        // Smart background switched on mid-pause: the element mounts now,
        // and it has no autoPlay attribute to fall back on.
        const blur = element();
        act(() => result.current.attachBgVideo(asVideo(blur)));
        expect(blur.plays).toBe(0);
        expect(blur.pauses).toBe(1);
    });

    it('starts a blur that mounts while the clip is playing', () => {
        const { result } = mountAttached();
        const blur = element();
        act(() => result.current.attachBgVideo(asVideo(blur)));
        expect(blur.plays).toBe(1);
    });

    /** A rejected `play()` is ordinary — autoplay policy, a file that will not
     *  decode — and must not reach the console as an unhandled rejection. */
    it('swallows a refused play', () => {
        const refusing = { ...element(), play: () => Promise.reject(new Error('NotAllowedError')) };
        expect(() => mountAttached({}, refusing as unknown as Stub)).not.toThrow();
    });

    it('survives an element whose play returns nothing', () => {
        // Older/stubbed elements return undefined rather than a promise.
        const old = { ...element(), play() { this.plays++; } };
        expect(() => mountAttached({}, old as unknown as Stub)).not.toThrow();
    });
});

describe('the scrubber', () => {
    it('follows the clip as it plays', () => {
        const { result, main } = mountAttached();
        main.currentTime = 30;
        act(() => result.current.handleTimeUpdate());
        expect(result.current.progress).toBe(30);
    });

    it('stays at 0 for a clip with no duration yet', () => {
        const { result, main } = mountAttached({}, element(NaN));
        main.currentTime = 5;
        act(() => result.current.handleTimeUpdate());
        expect(result.current.progress).toBe(0);
    });

    it('drags both videos to the same place', () => {
        const { result, main, bg } = mountAttached();
        act(() => result.current.seekToPercent(40));
        expect(main.currentTime).toBe(40);
        expect(bg.currentTime).toBe(40); // the blur must not drift
        expect(result.current.progress).toBe(40);
    });

    it('jumps by seconds for M and N, bringing the blur along', () => {
        const { result, main, bg } = mountAttached({}, element(100, 20), element(100, 20));
        act(() => result.current.seekBy(10));
        expect(main.currentTime).toBe(30);
        expect(bg.currentTime).toBe(30);
        expect(result.current.progress).toBe(30);
    });

    it('does nothing for a clip whose duration is unknown', () => {
        const { result, main } = mountAttached({}, element(NaN, 0));
        act(() => result.current.seekBy(10));
        expect(main.currentTime).toBe(0);
    });

    it('does nothing at all with no video attached', () => {
        const { result } = mount({ currentFile: { name: 'a.jpg', path: '/lib/a.jpg', type: 'image' } });
        expect(() => act(() => result.current.seekBy(10))).not.toThrow();
        expect(() => act(() => result.current.seekToPercent(50))).not.toThrow();
        expect(() => act(() => result.current.handleTimeUpdate())).not.toThrow();
    });
});

describe('a new slide', () => {
    it('starts unpaused, at the beginning of the scrubber', () => {
        const { result, rerender, main } = mountAttached();
        main.currentTime = 50;
        act(() => result.current.handleTimeUpdate());
        act(() => result.current.togglePause());
        expect(result.current.progress).toBe(50);
        expect(result.current.isUserPaused).toBe(true);

        act(() => rerender({ currentFile: clip('b.mp4') }));
        expect(result.current.progress).toBe(0);
        expect(result.current.isUserPaused).toBe(false);
    });

    /**
     * Keyed on the path, which is also the slide wrapper's React key — so a
     * re-sort that leaves the same file on screen leaves the playing video
     * alone. Keying on the index used to snap the scrubber back to 0 while
     * the element kept playing.
     */
    it('leaves a playing clip alone when the list is merely re-ordered', () => {
        const { result, rerender, main } = mountAttached();
        main.currentTime = 50;
        act(() => result.current.handleTimeUpdate());
        const plays = main.plays;
        act(() => rerender({ currentFile: clip() })); // same path, new object
        expect(result.current.progress).toBe(50);
        expect(main.plays).toBe(plays);
    });

    it('resets when the slideshow runs out of files', () => {
        const { result, rerender } = mountAttached();
        act(() => result.current.togglePause());
        act(() => rerender({ currentFile: null }));
        expect(result.current.isUserPaused).toBe(false);
    });
});

/** App names these in the keydown and `menu:action` dependency arrays, and a
 *  playing video re-renders about four times a second. */
describe('identity', () => {
    it('keeps the handlers stable while the clip plays', () => {
        const { result, main } = mountAttached();
        const before = { ...result.current };
        main.currentTime = 10;
        act(() => result.current.handleTimeUpdate());
        expect(result.current.progress).toBe(10); // it really did re-render
        expect(result.current.seekBy).toBe(before.seekBy);
        expect(result.current.seekToPercent).toBe(before.seekToPercent);
        expect(result.current.handleTimeUpdate).toBe(before.handleTimeUpdate);
        expect(result.current.togglePause).toBe(before.togglePause);
        expect(result.current.attachBgVideo).toBe(before.attachBgVideo);
    });

    /**
     * `attachVideo` is the exception and must not be memoized away: it closes
     * over the volume so a newly mounted element can be set before it is
     * audible. React calls a changed ref callback again, which re-applies it.
     */
    it('renews the attach callback when the volume changes', () => {
        const { result, rerender } = mountAttached({ volume: 1 });
        const before = result.current.attachVideo;
        act(() => rerender({ volume: 0.2 }));
        expect(result.current.attachVideo).not.toBe(before);
    });
});

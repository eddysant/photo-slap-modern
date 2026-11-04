// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    KEN_BURNS_ANIMATIONS, pickKenBurns, useSlideDecorations,
} from '../src/hooks/useSlideDecorations';

/**
 * Both of these were one effect in `App`, keyed on `currentIndex` plus the
 * whole `files` array, with nothing cancelling the EXIF read. The two bugs
 * that produced are only visible from a rendered hook: a re-derive that left
 * the same photo on screen, and a navigation inside an in-flight fetch.
 */

const photo = (name = 'a.jpg'): MediaFile => ({ name, path: `/lib/${name}`, type: 'image' });
const clip = (name = 'a.mp4'): MediaFile => ({ name, path: `/lib/${name}`, type: 'video' });

/** Each path's EXIF is handed back only when the test releases it. */
let pending: Map<string, (data: ExifData | null) => void>;
let asked: string[];

beforeEach(() => {
    pending = new Map();
    asked = [];
    (globalThis as any).window.api = {
        getExif: vi.fn((path: string) => {
            asked.push(path);
            return new Promise<ExifData | null>(resolve => { pending.set(path, resolve); });
        }),
    };
});

afterEach(() => { cleanup(); });

const release = async (path: string, data: ExifData | null) => {
    const resolve = pending.get(path);
    if (!resolve) throw new Error(`nothing was asked for ${path}`);
    await act(async () => { resolve(data); });
};

interface Props {
    currentFile?: MediaFile | null;
    isExifEnabled?: boolean;
    isKenBurns?: boolean;
}

/** `random` is read once by the hook, so a stable stub is enough. */
const mount = (initial: Props = {}, random = () => 0) => renderHook(
    (props: Props) => useSlideDecorations({
        currentFile: props.currentFile === undefined ? photo() : props.currentFile,
        isExifEnabled: props.isExifEnabled ?? false,
        isKenBurns: props.isKenBurns ?? false,
        random,
    }),
    { initialProps: initial },
);

describe('pickKenBurns', () => {
    it('picks from the animations the stylesheet defines', () => {
        expect(KEN_BURNS_ANIMATIONS).toContain(pickKenBurns(() => 0.5));
    });

    it('spans the whole list', () => {
        expect(pickKenBurns(() => 0)).toBe(KEN_BURNS_ANIMATIONS[0]);
        expect(pickKenBurns(() => 0.999)).toBe(KEN_BURNS_ANIMATIONS[KEN_BURNS_ANIMATIONS.length - 1]);
    });

    // `Math.random()` cannot return 1, but a stub can, and an out-of-range
    // index would put `undefined` in a className.
    it('stays in range when the source misbehaves', () => {
        expect(KEN_BURNS_ANIMATIONS).toContain(pickKenBurns(() => 1));
        expect(KEN_BURNS_ANIMATIONS).toContain(pickKenBurns(() => -1));
    });
});

describe('the EXIF read', () => {
    it('is not made at all while the readout is off', () => {
        mount({ isExifEnabled: false });
        expect(asked).toEqual([]);
    });

    it('is not made for a video', () => {
        mount({ currentFile: clip(), isExifEnabled: true });
        expect(asked).toEqual([]);
    });

    it('lands on the photo it was made for', async () => {
        const { result } = mount({ isExifEnabled: true });
        await release('/lib/a.jpg', { Make: 'Canon' } as unknown as ExifData);
        expect(result.current.exifData).toEqual({ Make: 'Canon' });
    });

    /**
     * The bug. The fetch is async and nothing cancelled it, so navigating
     * while one was in flight put the previous photo's camera settings on the
     * photo now on screen.
     */
    it('is discarded when the slide has moved on', async () => {
        const { result, rerender } = mount({ isExifEnabled: true });
        rerender({ currentFile: photo('b.jpg'), isExifEnabled: true });
        expect(asked).toEqual(['/lib/a.jpg', '/lib/b.jpg']);

        await release('/lib/a.jpg', { Make: 'the previous photo' } as unknown as ExifData);
        expect(result.current.exifData).toBeNull();

        await release('/lib/b.jpg', { Make: 'this photo' } as unknown as ExifData);
        expect(result.current.exifData).toEqual({ Make: 'this photo' });
    });

    it('is cleared when the slide changes, not left showing the last one', async () => {
        const { result, rerender } = mount({ isExifEnabled: true });
        await release('/lib/a.jpg', { Make: 'Canon' } as unknown as ExifData);
        expect(result.current.exifData).not.toBeNull();

        rerender({ currentFile: photo('b.jpg'), isExifEnabled: true });
        expect(result.current.exifData).toBeNull();
    });

    it('is made again for the same photo when the readout is switched on', () => {
        const { rerender } = mount({ isExifEnabled: false });
        rerender({ isExifEnabled: true });
        expect(asked).toEqual(['/lib/a.jpg']);
    });
});

describe('the Ken Burns pan', () => {
    it('is empty while the setting is off', () => {
        const { result } = mount({ isKenBurns: false });
        expect(result.current.kenBurnsClass).toBe('');
    });

    it('is picked for a photo once the setting is on', () => {
        const { result } = mount({ isKenBurns: true });
        expect(KEN_BURNS_ANIMATIONS).toContain(result.current.kenBurnsClass);
    });

    /**
     * The bug this hook exists for. The effect listed `files`, which is a new
     * array after every delete, every re-sort and every folder-watch diff —
     * so a re-derive that left the same photo on screen re-rolled the class,
     * and changing a className restarts the CSS animation: the pan visibly
     * jumped back to its start. Same mistake `useVideoElement` made by keying
     * on the index instead of the path.
     */
    it('survives a re-render that leaves the same photo on screen', () => {
        let rolls = 0;
        const { result, rerender } = mount(
            { isKenBurns: true },
            () => { rolls++; return 0.4; },
        );
        const first = result.current.kenBurnsClass;
        expect(rolls).toBe(1);

        // A new MediaFile object for the same path, as a re-derive produces.
        rerender({ currentFile: photo(), isKenBurns: true });
        expect(rolls).toBe(1);
        expect(result.current.kenBurnsClass).toBe(first);
    });

    // One effect did both, so turning the readout on restarted the pan of the
    // photo already showing.
    it('survives the EXIF readout being switched on', () => {
        // A varying source on purpose: with a fixed one a re-roll returns the
        // same class, and the test passed against the bug it was written for.
        let roll = 0;
        const { result, rerender } = mount(
            { isKenBurns: true, isExifEnabled: false },
            () => { roll += 0.3; return roll; },
        );
        const first = result.current.kenBurnsClass;
        rerender({ isKenBurns: true, isExifEnabled: true });
        expect(result.current.kenBurnsClass).toBe(first);
    });

    it('is re-picked for a new photo', () => {
        let roll = 0;
        const { result, rerender } = mount(
            { isKenBurns: true },
            () => { roll += 0.3; return roll; },
        );
        const first = result.current.kenBurnsClass;
        rerender({ currentFile: photo('b.jpg'), isKenBurns: true });
        expect(result.current.kenBurnsClass).not.toBe(first);
    });

    /**
     * A video has nothing to pan, and the class has to be *cleared* rather
     * than left behind — the previous photo's pan would otherwise still be on
     * the element the slide wrapper hands it to.
     */
    it('is cleared for a video', () => {
        const { result, rerender } = mount({ isKenBurns: true });
        expect(result.current.kenBurnsClass).not.toBe('');
        rerender({ currentFile: clip(), isKenBurns: true });
        expect(result.current.kenBurnsClass).toBe('');
    });

    it('is cleared when the setting is switched off', () => {
        const { result, rerender } = mount({ isKenBurns: true });
        expect(result.current.kenBurnsClass).not.toBe('');
        rerender({ isKenBurns: false });
        expect(result.current.kenBurnsClass).toBe('');
    });

    it('is cleared when the library is closed', () => {
        const { result, rerender } = mount({ isKenBurns: true });
        rerender({ currentFile: null, isKenBurns: true });
        expect(result.current.kenBurnsClass).toBe('');
    });
});

describe('the object the hook returns', () => {
    // Everything here reaches a dependency array in App.
    it('keeps its identity across a re-render that changed nothing', async () => {
        const { result, rerender } = mount({ isKenBurns: true });
        const first = result.current;
        rerender({ isKenBurns: true });
        await waitFor(() => expect(result.current).toBe(first));
    });
});

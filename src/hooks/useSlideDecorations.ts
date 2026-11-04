import { useEffect, useMemo, useRef, useState } from 'react';

/** The CSS classes in `App.css` that pan or zoom a still photo. */
export const KEN_BURNS_ANIMATIONS = [
    'kb-pan-left', 'kb-pan-right', 'kb-pan-up', 'kb-pan-down', 'kb-zoom-in', 'kb-zoom-out',
] as const;

export type KenBurnsAnimation = typeof KEN_BURNS_ANIMATIONS[number];

/** Pure so the choice can be driven from a test rather than from chance. */
export function pickKenBurns(random: () => number = Math.random): KenBurnsAnimation {
    const index = Math.floor(random() * KEN_BURNS_ANIMATIONS.length);
    return KEN_BURNS_ANIMATIONS[Math.min(Math.max(index, 0), KEN_BURNS_ANIMATIONS.length - 1)];
}

export interface SlideDecorationOptions {
    currentFile: MediaFile | null;
    isExifEnabled: boolean;
    isKenBurns: boolean;
    /** Injectable only for tests, and read once; production uses `Math.random`. */
    random?: () => number;
}

/**
 * The two things a slide picks up when it lands: its EXIF, and the pan it will
 * drift with. Both are per-slide and neither belongs to the engine, but both
 * were wrong in the same way, and for the same reason.
 *
 * **Everything is keyed on the file's path, not on `currentIndex` plus the
 * list.** The effect this replaces listed `files`, which is a new array after
 * every delete, every re-sort and every folder-watch diff — so a re-derive
 * that left the same photo on screen re-rolled the Ken Burns class, and
 * changing the className restarts the CSS animation: the pan visibly jumped
 * back to its start. Same bug `useVideoElement` had when it keyed on the
 * index, and the same fix.
 *
 * **A late EXIF read is discarded.** The fetch is async and nothing cancelled
 * it, so navigating while one was in flight landed the previous photo's
 * camera settings on the photo now on screen.
 *
 * The two are separate effects on purpose: with one, turning the EXIF readout
 * on re-rolled the pan of the photo already showing.
 */
export function useSlideDecorations({
    currentFile, isExifEnabled, isKenBurns, random,
}: SlideDecorationOptions) {
    const [exifData, setExifData] = useState<ExifData | null>(null);
    const [kenBurnsClass, setKenBurnsClass] = useState('');

    const path = currentFile?.path ?? null;
    const isImage = currentFile?.type === 'image';

    // Captured once rather than listed as a dependency: an inline arrow from
    // a caller would otherwise re-roll the pan on every render.
    const randomRef = useRef(random);

    useEffect(() => {
        setExifData(null);
        if (!path || !isImage || !isExifEnabled) return;
        let live = true;
        window.api.getExif(path)
            .then(data => { if (live) setExifData(data); })
            .catch(e => console.error('Could not read EXIF:', e));
        return () => { live = false; };
    }, [path, isImage, isExifEnabled]);

    useEffect(() => {
        // A video has nothing to pan, and the class has to be cleared rather
        // than left behind: the previous photo's pan would otherwise stay on.
        if (!path || !isImage || !isKenBurns) {
            setKenBurnsClass('');
            return;
        }
        setKenBurnsClass(pickKenBurns(randomRef.current));
    }, [path, isImage, isKenBurns]);

    return useMemo(() => ({ exifData, kenBurnsClass }), [exifData, kenBurnsClass]);
}

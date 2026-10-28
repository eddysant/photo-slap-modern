import { useEffect, useRef } from 'react';
import { getDisplayUrl } from '../utils';

/** Slides fetched ahead, so a transition never waits on the disk. */
const PRELOAD_COUNT = 6;
/**
 * Of those, how many are decoded to pixels. A decoded slide costs
 * width x height x 4 bytes of resident memory and the next one is the only
 * one a transition can actually need; the rest are warm in the HTTP cache
 * and decode in a frame or two when their turn comes.
 */
const DECODE_COUNT = 2;
/** Decoded images to keep around; a little more than one window's worth. */
const CACHE_LIMIT = 8;

/**
 * Warm the next few slides so a transition never waits on a decode.
 *
 * Entries are kept in an insertion-ordered cache rather than rebuilt per
 * slide: advancing one slide previously threw away ten Image objects and
 * created ten more, nine of which were the same URLs it had just discarded.
 */
export function useImagePreloader(files: MediaFile[], currentIndex: number, maxDim?: number) {
    const cache = useRef(new Map<string, HTMLImageElement>());

    useEffect(() => {
        if (files.length === 0) return;

        for (let i = 1; i <= PRELOAD_COUNT; i++) {
            const file = files[(currentIndex + i) % files.length];
            if (file.type !== 'image') continue;

            const url = getDisplayUrl(file.path, maxDim);
            if (cache.current.has(url)) {
                // Refresh recency so the window we are moving through survives
                const img = cache.current.get(url)!;
                cache.current.delete(url);
                cache.current.set(url, img);
                continue;
            }

            const img = new Image();
            img.src = url;
            // decode() warms the pixel cache so the incoming slide paints on
            // the first transition frame instead of decoding mid-wipe. Only
            // the slides close enough to be transitioned to are worth the
            // bitmap; beyond that the fetch alone is the win.
            if (i <= DECODE_COUNT) img.decode().catch(() => { });
            cache.current.set(url, img);
        }

        while (cache.current.size > CACHE_LIMIT) {
            const oldest = cache.current.keys().next().value;
            if (oldest === undefined) break;
            release(cache.current.get(oldest));
            cache.current.delete(oldest);
        }
    }, [files, currentIndex, maxDim]);

    // Drop everything when the library changes so a new folder doesn't
    // inherit the previous one's decoded bitmaps.
    const cacheRef = cache;
    useEffect(() => () => {
        for (const img of cacheRef.current.values()) release(img);
        cacheRef.current.clear();
    }, [cacheRef]);
}

/**
 * Dropping the last reference is not enough: an `Image` whose load is still
 * in flight stays alive until it settles, and its decoded bitmap is freed on
 * the renderer's own schedule. Clearing `src` cancels the load and lets the
 * pixels go now, which is what a photo frame running for weeks needs.
 */
function release(img: HTMLImageElement | undefined) {
    if (!img) return;
    img.src = '';
}

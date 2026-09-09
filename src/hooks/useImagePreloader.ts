import { useEffect, useRef } from 'react';
import { getDisplayUrl } from '../utils';

const PRELOAD_COUNT = 10;
/** Decoded images to keep around; a little more than one window's worth. */
const CACHE_LIMIT = 24;

/**
 * Warm the next few slides so a transition never waits on a decode.
 *
 * Entries are kept in an insertion-ordered cache rather than rebuilt per
 * slide: advancing one slide previously threw away ten Image objects and
 * created ten more, nine of which were the same URLs it had just discarded.
 */
export function useImagePreloader(files: MediaFile[], currentIndex: number) {
    const cache = useRef(new Map<string, HTMLImageElement>());

    useEffect(() => {
        if (files.length === 0) return;

        for (let i = 1; i <= PRELOAD_COUNT; i++) {
            const file = files[(currentIndex + i) % files.length];
            if (file.type !== 'image') continue;

            const url = getDisplayUrl(file.path);
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
            // the first transition frame instead of decoding mid-wipe
            img.decode().catch(() => { });
            cache.current.set(url, img);
        }

        while (cache.current.size > CACHE_LIMIT) {
            const oldest = cache.current.keys().next().value;
            if (oldest === undefined) break;
            cache.current.delete(oldest);
        }
    }, [files, currentIndex]);

    // Drop everything when the library changes so a new folder doesn't
    // inherit the previous one's decoded bitmaps.
    const cacheRef = cache;
    useEffect(() => () => { cacheRef.current.clear(); }, [cacheRef]);
}

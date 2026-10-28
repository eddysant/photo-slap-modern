import { useEffect, useState } from 'react';
import { MAX_SLIDE_DIM, getDisplayUrl, slideDisplayDim } from '../utils';

/**
 * How big a slide should be fetched, and the URL to paint for the one on
 * screen.
 *
 * Two rules. A slide is never fetched larger than the window can show, which
 * on a 1080p photo frame is a quarter of the pixels the old fixed 4096 cost,
 * in the decoded bitmap and again in the GPU texture. And zooming is the one
 * thing that can show more detail than the window holds, so it upgrades to
 * the full-size variant — decoded first and swapped in only once it is ready,
 * because setting `src` on a visible `<img>` blanks it until the new bitmap
 * arrives. The upgrade is dropped on the next slide, which is what releases
 * the larger texture again.
 */
export function useSlideSource(path: string | null, type: string | undefined, isZoomed: boolean) {
    const [dim, setDim] = useState(() => slideDisplayDim());

    // A window moved to a bigger display, or made fullscreen, needs more
    // pixels than it did; the bucket keeps this from firing on every frame
    // of a drag-resize.
    useEffect(() => {
        const onResize = () => setDim(slideDisplayDim());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const [upgraded, setUpgraded] = useState<string | null>(null);

    useEffect(() => {
        if (!isZoomed || !path || type !== 'image' || dim >= MAX_SLIDE_DIM) return;
        const url = getDisplayUrl(path, MAX_SLIDE_DIM);
        if (url === getDisplayUrl(path, dim)) return; // not a scalable image
        let cancelled = false;
        const img = new Image();
        img.src = url;
        img.decode()
            .then(() => { if (!cancelled) setUpgraded(url); })
            .catch(() => { /* leave the window-sized variant in place */ });
        return () => { cancelled = true; };
    }, [isZoomed, path, type, dim]);

    // A new slide starts from the window-sized variant again.
    useEffect(() => { setUpgraded(null); }, [path]);

    return {
        dim,
        src: path === null ? null : upgraded ?? getDisplayUrl(path, dim),
    };
}

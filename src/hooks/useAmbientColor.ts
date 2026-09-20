import { useEffect, useRef, useState } from 'react';

/** How far the average colour is dimmed so it reads as a backdrop. */
const BACKDROP_DIM = 0.42;

/** #rrggbb -> a dimmed rgb() string, or null for anything unparseable. */
export function dimHexColor(hex: string | null, factor = BACKDROP_DIM): string | null {
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    const channel = (at: number) => Math.round(parseInt(hex.slice(at, at + 2), 16) * factor);
    return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

/**
 * Average colour of the current photo, dimmed for use behind it.
 *
 * Only images have one — a video keeps the plain backdrop rather than paying
 * for a frame grab. Results are memoised per path here as well as in the main
 * process, so flipping back and forth through a library doesn't re-ask.
 */
export function useAmbientColor(file: MediaFile | null, enabled: boolean): string | null {
    const [color, setColor] = useState<string | null>(null);
    const cache = useRef(new Map<string, string | null>());

    const path = file?.type === 'image' ? file.path : null;

    useEffect(() => {
        if (!enabled || !path) {
            setColor(null);
            return;
        }
        if (cache.current.has(path)) {
            setColor(dimHexColor(cache.current.get(path) ?? null));
            return;
        }
        let cancelled = false;
        window.api.getAmbientColor(path)
            .then(hex => {
                cache.current.set(path, hex);
                if (!cancelled) setColor(dimHexColor(hex));
            })
            .catch(() => { if (!cancelled) setColor(null); });
        return () => { cancelled = true; };
    }, [path, enabled]);

    // A new library shouldn't inherit the previous one's colours
    const cacheRef = cache;
    useEffect(() => () => { cacheRef.current.clear(); }, [cacheRef]);

    return enabled ? color : null;
}

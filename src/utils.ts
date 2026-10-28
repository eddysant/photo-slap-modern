/**
 * Build a media:// URL for a local file. The main process serves these via a
 * custom protocol that only allows files inside user-opened directories
 * (and transcodes HEIC to JPEG). The "local" host is a required placeholder —
 * standard-scheme URLs must have a host or the first path segment would be
 * swallowed (and lowercased) as one.
 */
export function getFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    return `media://local${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

const SCALABLE_IMAGE = /\.(jpe?g|png|webp|bmp|heic|heif)$/i;

/**
 * media:// URL for a display-sized variant of an image (longest side capped
 * at maxDim, downscaled and cached by the main process). Full-resolution
 * camera photos are enormous GPU textures — several alive at once during a
 * slide transition causes texture thrash and visible artifacts, so the
 * slideshow never paints originals. Non-scalable files (videos, GIFs) get
 * their plain URL.
 */
export function getDisplayUrl(filePath: string, maxDim = MAX_SLIDE_DIM): string {
    const base = getFileUrl(filePath);
    return SCALABLE_IMAGE.test(filePath) ? `${base}?w=${maxDim}` : base;
}

/** Upper bound on any slide variant, and the size a zoomed slide upgrades to. */
export const MAX_SLIDE_DIM = 4096;
const MIN_SLIDE_DIM = 1024;
/** Variants are bucketed so a window resize doesn't re-derive on every pixel. */
const SLIDE_DIM_BUCKET = 512;

/**
 * The longest side a slide actually needs, in device pixels.
 *
 * A fixed 4096 was four times too wide for the 1080p panel a photo frame
 * usually hangs on, and the renderer paid for every one of those pixels:
 * the decoded bitmap, the GPU texture, and both again for the slide being
 * transitioned away from. The image is letterboxed, so the longest window
 * side is the most of it that can ever be shown — anything beyond that is
 * resolution nobody can see. Zooming is the exception, and upgrades to
 * `MAX_SLIDE_DIM` on demand.
 */
export function slideDisplayDim(
    width = window.innerWidth,
    height = window.innerHeight,
    dpr = window.devicePixelRatio || 1,
): number {
    const needed = Math.max(width, height) * dpr;
    const bucketed = Math.ceil(needed / SLIDE_DIM_BUCKET) * SLIDE_DIM_BUCKET;
    return Math.min(MAX_SLIDE_DIM, Math.max(MIN_SLIDE_DIM, bucketed));
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = '';
    for (const u of units) {
        value /= 1024;
        unit = u;
        if (value < 1024) break;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

const MIN_THUMB_DIM = 128;
const MAX_THUMB_DIM = 512;
const THUMB_DIM_BUCKET = 128;

/**
 * The longest side a grid thumbnail needs, for a cell of `cellSize` CSS
 * pixels. A fixed 512 was most of a megabyte of decoded bitmap per cell,
 * and the grid keeps roughly fifty of them mounted; cells are rarely more
 * than 250px, so most of those pixels were never shown. Bucketed, so
 * dragging the window wider doesn't re-derive every visible thumbnail.
 */
export function thumbDisplayDim(cellSize: number, dpr = window.devicePixelRatio || 1): number {
    const needed = cellSize * dpr;
    const bucketed = Math.ceil(needed / THUMB_DIM_BUCKET) * THUMB_DIM_BUCKET;
    return Math.min(MAX_THUMB_DIM, Math.max(MIN_THUMB_DIM, bucketed));
}

import { describe, it, expect } from 'vitest';
import {
    MAX_SLIDE_DIM, formatBytes, getDisplayUrl, getFileUrl,
    slideDisplayDim, thumbDisplayDim,
} from '../src/utils';

describe('formatBytes', () => {
    it('formats each magnitude', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
        expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
    });
});

describe('getFileUrl', () => {
    it('builds a media:// URL with the local placeholder host', () => {
        expect(getFileUrl('/Users/me/pic.jpg')).toBe('media://local/Users/me/pic.jpg');
    });

    it('percent-encodes special characters per segment', () => {
        expect(getFileUrl('/Users/me/my photos/#1 pick.jpg'))
            .toBe('media://local/Users/me/my%20photos/%231%20pick.jpg');
    });

    it('handles Windows paths', () => {
        expect(getFileUrl('C:\\Users\\me\\pic.jpg')).toBe('media://local/C%3A/Users/me/pic.jpg');
    });

    it('round-trips through URL parsing without host-swallowing', () => {
        const url = new URL(getFileUrl('/Users/me/pic.jpg'));
        expect(url.host).toBe('local');
        expect(decodeURIComponent(url.pathname)).toBe('/Users/me/pic.jpg');
    });
});

describe('slideDisplayDim', () => {
    // The whole point: a 1080p photo frame paints a quarter of the pixels a
    // fixed 4096 used to cost, in the bitmap and again in the GPU texture.
    it('sizes a 1080p frame to its own panel, not to 4096', () => {
        expect(slideDisplayDim(1920, 1080, 1)).toBe(2048);
    });

    it('accounts for device pixel ratio', () => {
        expect(slideDisplayDim(1200, 800, 2)).toBe(2560);
        expect(slideDisplayDim(1200, 800, 1)).toBe(1536);
    });

    it('uses the longest side, since the photo is letterboxed', () => {
        expect(slideDisplayDim(800, 1600, 1)).toBe(2048); // 1024 if it only looked at width
    });

    it('never asks for more than the pipeline will produce', () => {
        expect(slideDisplayDim(6016, 3384, 2)).toBe(MAX_SLIDE_DIM);
    });

    it('keeps a floor, so a tiny window still has something to zoom into', () => {
        expect(slideDisplayDim(320, 240, 1)).toBe(1024);
    });

    // Buckets are what keep a drag-resize from re-deriving on every frame,
    // and what keep the disk cache from holding one entry per window width.
    it('buckets nearby sizes to the same variant', () => {
        expect(slideDisplayDim(1201, 800, 2)).toBe(slideDisplayDim(1270, 800, 2));
    });

    it('rounds up, never down, so a variant is never upscaled', () => {
        expect(slideDisplayDim(1537, 100, 1)).toBeGreaterThanOrEqual(1537);
    });
});

describe('thumbDisplayDim', () => {
    it('sizes a thumbnail to its cell', () => {
        expect(thumbDisplayDim(180, 2)).toBe(384);
        expect(thumbDisplayDim(180, 1)).toBe(256);
    });

    it('caps at the largest thumbnail the grid ever needs', () => {
        expect(thumbDisplayDim(900, 2)).toBe(512);
    });

    it('buckets, so widening the window does not re-derive every tile', () => {
        expect(thumbDisplayDim(150, 2)).toBe(thumbDisplayDim(192, 2));
    });
});

describe('getDisplayUrl', () => {
    it('asks for the variant it is given', () => {
        expect(getDisplayUrl('/lib/a.jpg', 2048)).toBe('media://local/lib/a.jpg?w=2048');
    });

    // Resizing a GIF would drop the animation; a video has no variant at all.
    it('leaves animated and non-image files alone', () => {
        expect(getDisplayUrl('/lib/a.gif', 2048)).toBe('media://local/lib/a.gif');
        expect(getDisplayUrl('/lib/a.mp4', 2048)).toBe('media://local/lib/a.mp4');
    });
});

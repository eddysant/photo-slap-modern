import fs from 'node:fs/promises';
import { INVALID_HEADER, parseBoxHeader, SHORT_HEADER } from './isoBmff';

/**
 * A video integrity check that does not decode the video.
 *
 * The health scan used to validate a video by reading the `ftyp` signature
 * in the first twelve bytes and nothing else, which says only "this file
 * began life as an mp4". Measured: an mp4 truncated to 30% of its bytes was
 * reported perfectly healthy, and so was the same file under a deep scan,
 * since that path is image-only. For the format whose failure the whole
 * stall watchdog exists to survive, the scan could not tell the user
 * anything at all.
 *
 * `.mp4` and `.mov` are ISO base media format, the same container as HEIC,
 * so the same trick applies: the boxes declare how long the file is, and
 * comparing that against the file actually on disk catches truncation — a
 * copy that stopped, a sync that died, a card pulled mid-write. A playable
 * video also has to carry its `moov` (the index: timescale, sample tables,
 * track layout). A file whose `moov` never arrived cannot be played by
 * anything, and that is precisely what a truncated download leaves behind.
 *
 * What this does NOT do is validate the encoded frames. A file can satisfy
 * every check here and still fail to decode — the codec may be unsupported
 * on this machine, which for HEVC depends on the hardware. The slideshow
 * already survives that (`onError` skip, stall watchdog); the point here is
 * to stop reporting a file as healthy when it demonstrably is not.
 *
 * Unlike `heifStructure`, this seeks rather than working from a buffered
 * head: a video's `moov` is commonly written *after* the media data, so on
 * anything but a faststart file it sits behind a potentially multi-gigabyte
 * `mdat`. Top-level boxes are few, so this costs a handful of 16-byte reads.
 */

export type VideoStructure =
    /** Boxes are complete and self-consistent, and the index is present. */
    | { kind: 'intact' }
    /** The file contradicts itself, or cannot be played by anything. */
    | { kind: 'damaged'; detail: string }
    /** Not understood here. The caller should fall back to whatever it had. */
    | { kind: 'unknown' };

/** Walking more than this many top-level boxes means we are not reading boxes. */
const MAX_TOP_LEVEL_BOXES = 256;

/**
 * Reads the top-level box list by seeking to each header in turn. Never
 * throws: an unreadable file comes back as `unknown`.
 */
export async function inspectVideoStructure(filePath: string, fileSize: number): Promise<VideoStructure> {
    if (fileSize < 8) return { kind: 'damaged', detail: 'The video file is empty or far too small to be one.' };

    let handle;
    try {
        handle = await fs.open(filePath, 'r');
    } catch {
        return { kind: 'unknown' };
    }

    try {
        const header = Buffer.alloc(16);
        const seen = new Set<string>();
        let offset = 0;
        let boxes = 0;

        while (offset < fileSize) {
            if (boxes++ > MAX_TOP_LEVEL_BOXES) return { kind: 'unknown' };

            // Fewer than eight bytes left for a header means the previous
            // box's size pointed past the end of the file.
            if (offset + 8 > fileSize) {
                return { kind: 'damaged', detail: 'The video ends in the middle of its own structure — it looks truncated.' };
            }

            const { bytesRead } = await handle.read(header, 0, 16, offset);
            const parsed = parseBoxHeader(header.subarray(0, bytesRead), 0);
            if (parsed === SHORT_HEADER || parsed === INVALID_HEADER) return { kind: 'unknown' };

            // The very first box identifies the container. Anything else and
            // this is not a file we may pass judgement on.
            if (boxes === 1 && parsed.type !== 'ftyp') return { kind: 'unknown' };

            seen.add(parsed.type);

            if (parsed.declaredSize === null) break; // runs to the end of the file
            const end = offset + parsed.declaredSize;
            // An empty box is legal and real: ffmpeg writes a `free` of
            // exactly 8 bytes, header and no payload. Rejecting a zero-length
            // payload called every ordinary mp4 unreadable.
            if (end < offset + parsed.headerSize) return { kind: 'unknown' };
            if (end > fileSize) {
                return { kind: 'damaged', detail: 'The video ends before its own boxes do — it looks truncated.' };
            }
            offset = end;
        }

        // `moov` is the index: without it there is nothing to tell a player
        // how to read the media, which is exactly what a download cut short
        // leaves behind.
        if (!seen.has('moov')) {
            return { kind: 'damaged', detail: 'The video is missing its index (no moov box) and cannot be played.' };
        }
        if (!seen.has('mdat')) {
            return { kind: 'damaged', detail: 'The video declares no media data.' };
        }
        return { kind: 'intact' };
    } catch {
        return { kind: 'unknown' };
    } finally {
        await handle.close().catch(() => { /* already closing down */ });
    }
}

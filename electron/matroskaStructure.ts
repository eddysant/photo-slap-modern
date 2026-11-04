import fs from 'node:fs/promises';

/**
 * A `.webm`/`.mkv` integrity check that does not decode the video.
 *
 * These were the last videos checked by their signature alone: four magic
 * bytes said "this began life as a Matroska file" and nothing else, so one
 * truncated mid-download read as perfectly healthy — the gap
 * `videoStructure.ts` closed for the ISO-BMFF family, still open for its
 * sibling. The deep scan does not help; that path is image-only.
 *
 * EBML is a different format from ISO-BMFF with the same useful property:
 * every element declares its own length, so the structure can be checked
 * against the bytes actually on disk. Nothing here is shared with
 * `isoBmff.ts` — the length encoding is the whole difference between the two
 * containers — and the walk seeks for the same reason: a Cluster can be
 * megabytes and a Segment can be the entire file.
 *
 * What it does NOT do is validate the encoded frames, which for `.mkv`
 * matters more than for most: the container admits any codec at all, so a
 * structurally perfect file may still be undecodable on this machine. The
 * slideshow already survives that (`onError` skip, stall watchdog). The
 * point is to stop calling a file healthy when it demonstrably is not.
 */

export type MatroskaStructure =
    /** Elements are complete and self-consistent, with tracks and media present. */
    | { kind: 'intact' }
    /** The file contradicts itself, or cannot be played by anything. */
    | { kind: 'damaged'; detail: string }
    /** Not understood here. The caller should fall back to whatever it had. */
    | { kind: 'unknown' };

/** Element IDs, as the raw big-endian bytes including their length marker. */
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;

/** Walking more than this many elements means we are not reading elements. */
const MAX_ELEMENTS = 4096;

/**
 * An EBML header is a handful of small fields — ffmpeg writes 31 bytes, and
 * the spec gives it no reason to be large. The four magic bytes alone are a
 * weak claim: anything can begin with them, and the next byte then reads as
 * a length field, producing a declared extent far past the end of the file —
 * the exact signature of truncation. So a wildly over-long first element
 * means these bytes are not an element tree, and the magic-byte check stays
 * the authority rather than this alleging a corrupt video. It is the
 * ordering `heifStructure` had to learn, where judging truncation before
 * establishing the format reported every unrecognised file as damaged.
 *
 * A header that overruns the file by a *plausible* amount is still
 * truncation, and still reported: that is a real webm cut off in its first
 * few dozen bytes.
 */
const MAX_EBML_HEADER_BYTES = 4096;

/** Enough for the widest header there is: a 4-byte ID and an 8-byte size. */
const HEADER_BYTES = 12;

export interface ElementHeader {
    /** The ID with its length marker intact, which is how EBML IDs are written. */
    id: number;
    /** Bytes of header before the payload. */
    headerSize: number;
    /**
     * Declared payload length, or null for the "unknown size" encoding — all
     * value bits set. That is legal and in use: a muxer writing to a pipe
     * cannot know how long its Segment will be, and ffmpeg emits exactly
     * this. Reading it as a length instead yields a gigantic number that
     * looks precisely like truncation.
     */
    payloadSize: number | null;
}

/** Not enough bytes present to read a header at all. */
export const SHORT_ELEMENT = 'short';
/** Bytes that cannot be an EBML element header. */
export const INVALID_ELEMENT = 'invalid';

export type ElementHeaderResult = ElementHeader | typeof SHORT_ELEMENT | typeof INVALID_ELEMENT;

/**
 * Width of a variable-length integer from its first byte: the number of
 * leading zero bits says how many bytes follow. `0x00` describes a width
 * beyond the eight bytes EBML allows, so it is simply not a VINT.
 */
function vintWidth(first: number): number {
    for (let width = 1; width <= 8; width++) {
        if (first & (0x80 >> (width - 1))) return width;
    }
    return 0;
}

export function parseElementHeader(buf: Buffer, at: number): ElementHeaderResult {
    if (at < 0 || at >= buf.length) return SHORT_ELEMENT;

    const idWidth = vintWidth(buf[at]);
    // An ID keeps its marker bit, and EBML defines none wider than four
    // bytes — so a wider one is not an ID, rather than a huge one.
    if (idWidth === 0 || idWidth > 4) return INVALID_ELEMENT;
    if (at + idWidth >= buf.length) return SHORT_ELEMENT;

    let id = 0;
    for (let i = 0; i < idWidth; i++) id = id * 0x100 + buf[at + i];

    const sizeAt = at + idWidth;
    const sizeWidth = vintWidth(buf[sizeAt]);
    if (sizeWidth === 0) return INVALID_ELEMENT;
    if (sizeAt + sizeWidth > buf.length) return SHORT_ELEMENT;

    // The size drops its marker bit, unlike the ID.
    let size = buf[sizeAt] & (0xff >> sizeWidth);
    let allOnes = size === (0xff >> sizeWidth);
    for (let i = 1; i < sizeWidth; i++) {
        const byte = buf[sizeAt + i];
        size = size * 0x100 + byte;
        if (byte !== 0xff) allOnes = false;
    }

    const headerSize = idWidth + sizeWidth;
    if (allOnes) return { id, headerSize, payloadSize: null };
    if (size > Number.MAX_SAFE_INTEGER) return INVALID_ELEMENT;
    return { id, headerSize, payloadSize: size };
}

const TRUNCATED = 'The video ends before its own structure does — it looks truncated.';

/**
 * Walks the top-level elements, and the children of the Segment, by seeking
 * to each header in turn. Never throws: an unreadable file comes back as
 * `unknown`.
 */
export async function inspectMatroskaStructure(filePath: string, fileSize: number): Promise<MatroskaStructure> {
    if (fileSize < 4) {
        return { kind: 'damaged', detail: 'The video file is empty or far too small to be one.' };
    }

    let handle;
    try {
        handle = await fs.open(filePath, 'r');
    } catch {
        return { kind: 'unknown' };
    }

    try {
        const header = Buffer.alloc(HEADER_BYTES);
        const readHeader = async (offset: number): Promise<ElementHeaderResult> => {
            const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, offset);
            return parseElementHeader(header.subarray(0, bytesRead), 0);
        };

        let elements = 0;
        let offset = 0;
        let sawSegment = false;
        let sawTracks = false;
        let sawCluster = false;

        // Children of an unknown-size element cannot be stepped over, so a
        // walk that meets one stops there rather than guessing.
        let openEnded = false;

        while (offset < fileSize && !openEnded) {
            if (elements++ > MAX_ELEMENTS) return { kind: 'unknown' };

            const parsed = await readHeader(offset);
            if (parsed === SHORT_ELEMENT) {
                // Bytes left over that cannot hold a header: the previous
                // element's declared length pointed past the end of the file.
                return { kind: 'damaged', detail: TRUNCATED };
            }
            if (parsed === INVALID_ELEMENT) return { kind: 'unknown' };

            // The first element identifies the container. Anything else and
            // this is not a file we may pass judgement on — the same ordering
            // `heifStructure` had to learn: alleging truncation from length
            // fields read out of bytes that are not a length field at all
            // condemns every file we simply do not recognise.
            if (elements === 1) {
                if (parsed.id !== ID_EBML) return { kind: 'unknown' };
                if (parsed.payloadSize === null || parsed.payloadSize > MAX_EBML_HEADER_BYTES) {
                    return { kind: 'unknown' };
                }
            }

            if (parsed.id === ID_SEGMENT) {
                sawSegment = true;
                const segmentEnd = parsed.payloadSize === null
                    ? fileSize
                    : offset + parsed.headerSize + parsed.payloadSize;
                if (parsed.payloadSize !== null && segmentEnd > fileSize) {
                    return { kind: 'damaged', detail: TRUNCATED };
                }

                let child = offset + parsed.headerSize;
                while (child < segmentEnd) {
                    if (elements++ > MAX_ELEMENTS) return { kind: 'unknown' };

                    const inner = await readHeader(child);
                    if (inner === SHORT_ELEMENT) return { kind: 'damaged', detail: TRUNCATED };
                    if (inner === INVALID_ELEMENT) return { kind: 'unknown' };

                    if (inner.id === ID_TRACKS) sawTracks = true;
                    if (inner.id === ID_CLUSTER) sawCluster = true;

                    if (inner.payloadSize === null) {
                        // A live-muxed Cluster legitimately runs to the end of
                        // the Segment. Nothing after it can be found, but what
                        // was found still counts.
                        openEnded = true;
                        break;
                    }
                    const end = child + inner.headerSize + inner.payloadSize;
                    if (end > fileSize) return { kind: 'damaged', detail: TRUNCATED };
                    child = end;
                }

                offset = segmentEnd;
                continue;
            }

            if (parsed.payloadSize === null) {
                // Only a Segment may sensibly be open-ended at the top level.
                return { kind: 'unknown' };
            }
            const end = offset + parsed.headerSize + parsed.payloadSize;
            if (end > fileSize) return { kind: 'damaged', detail: TRUNCATED };
            offset = end;
        }

        if (!sawSegment) {
            return { kind: 'damaged', detail: 'The video holds nothing but its EBML header — it looks truncated.' };
        }
        // Tracks is the index: codec, resolution, which streams exist. A file
        // without it cannot be played by anything, and it is what a download
        // cut short leaves behind.
        if (!sawTracks) {
            return { kind: 'damaged', detail: 'The video is missing its track information and cannot be played.' };
        }
        if (!sawCluster) {
            return { kind: 'damaged', detail: 'The video declares no media data.' };
        }
        return { kind: 'intact' };
    } catch {
        return { kind: 'unknown' };
    } finally {
        await handle.close().catch(() => { /* already closing down */ });
    }
}

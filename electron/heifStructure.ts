import fs from 'node:fs/promises';

/**
 * A HEIC health check that does not decode the image.
 *
 * `inspectMediaFile` only ever wanted two things from a HEIC: its
 * dimensions, and the knowledge that the file is not rotten. It got both by
 * running the whole WASM HEVC decoder over every photo — measured at 1020ms
 * each, which is half an hour on a 2,000-photo library.
 *
 * HEIF is ISO base media format: a tree of length-prefixed boxes, with the
 * metadata (`ftyp`, `meta`) ahead of the pixel data (`mdat`). Walking that
 * tree reads dimensions from the `ispe` box and, more importantly, proves
 * the file's own declared extents fit inside the file that is actually on
 * disk. Truncation — a copy that stopped, a sync that died, a card pulled
 * mid-write — is the realistic way a photo in someone's library goes bad,
 * and it is exactly what those extents catch.
 *
 * It is NOT the same guarantee as a decode: a file whose boxes are all
 * present and whose HEVC payload is nonetheless garbage reads as intact
 * here. That is the trade, and it is why the result distinguishes `unknown`
 * from `intact` — anything this parser does not fully understand is handed
 * back to the decoder rather than quietly passed.
 */

export type HeifStructure =
    /** The box tree is complete and self-consistent; dimensions came from `ispe`. */
    | { kind: 'intact'; width: number; height: number }
    /** The file contradicts itself — almost always truncation. */
    | { kind: 'damaged'; detail: string }
    /** Not understood here. The caller must fall back to a real decode. */
    | { kind: 'unknown' };

/**
 * `meta` must live in here for the check to mean anything. Real HEICs put it
 * within the first few KB; the budget is generous so an unusual writer that
 * leads with a large `ftyp` or an EXIF item still parses.
 */
const HEAD_BYTES = 256 * 1024;

/** Brands that mean "this is a HEIF still image" (ISO/IEC 23008-12). */
const HEIF_BRANDS = new Set([
    'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1',
]);

interface Box {
    type: string;
    /** Offset of the box's first payload byte, from the start of the file. */
    payloadStart: number;
    /** Offset one past the box's last byte, from the start of the file. */
    end: number;
}

interface BoxWalk {
    boxes: Box[];
    /** A box reached past the end it was given — the file is short. */
    truncated: boolean;
    /** A header could not be read, or a size made no sense. */
    unreadable: boolean;
}

/**
 * Walks the boxes between `start` and `limit`. `buf` holds the head of the
 * file at offset 0, so a box payload may legitimately lie beyond it (`mdat`
 * always does) — only headers are read here, and a header that falls outside
 * the head stops the walk as `unreadable` rather than guessing.
 */
function walkBoxes(buf: Buffer, start: number, limit: number): BoxWalk {
    const boxes: Box[] = [];
    let offset = start;
    while (offset < limit) {
        // A box with fewer than 8 bytes left for its header is a short file,
        // not an unparseable one: the previous box's size pointed here.
        if (offset + 8 > limit) return { boxes, truncated: true, unreadable: false };
        if (offset + 8 > buf.length) return { boxes, truncated: false, unreadable: true };

        let size = buf.readUInt32BE(offset);
        const type = buf.toString('latin1', offset + 4, offset + 8);
        let payloadStart = offset + 8;

        if (size === 1) {
            // 64-bit size, in the eight bytes after the type.
            if (payloadStart + 8 > buf.length) return { boxes, truncated: false, unreadable: true };
            const large = buf.readBigUInt64BE(payloadStart);
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { boxes, truncated: false, unreadable: true };
            size = Number(large);
            payloadStart += 8;
        } else if (size === 0) {
            // "To the end of the file", which only the last box may claim.
            boxes.push({ type, payloadStart, end: limit });
            return { boxes, truncated: false, unreadable: false };
        }

        const end = offset + size;
        if (end <= payloadStart) return { boxes, truncated: false, unreadable: true };
        if (end > limit) {
            boxes.push({ type, payloadStart, end });
            return { boxes, truncated: true, unreadable: false };
        }
        boxes.push({ type, payloadStart, end });
        offset = end;
    }
    return { boxes, truncated: false, unreadable: false };
}

/** Descends into a container box whose payload is entirely within the head. */
function children(buf: Buffer, box: Box, skip = 0): BoxWalk | null {
    const start = box.payloadStart + skip;
    if (box.end > buf.length || start > box.end) return null;
    return walkBoxes(buf, start, box.end);
}

/** Depth-first collect of every `ispe` under a `meta` box. */
function collectSpatialExtents(buf: Buffer, box: Box, depth: number): { width: number; height: number }[] {
    if (depth > 6) return [];
    // `meta` carries a version/flags word before its children; the property
    // containers it leads to (`iprp`, `ipco`) do not.
    const walk = children(buf, box, box.type === 'meta' ? 4 : 0);
    if (!walk) return [];
    const found: { width: number; height: number }[] = [];
    for (const child of walk.boxes) {
        if (child.type === 'ispe') {
            // FullBox: version/flags, then width and height.
            if (child.payloadStart + 12 > buf.length || child.end < child.payloadStart + 12) continue;
            found.push({
                width: buf.readUInt32BE(child.payloadStart + 4),
                height: buf.readUInt32BE(child.payloadStart + 8),
            });
        } else if (child.type === 'iprp' || child.type === 'ipco') {
            found.push(...collectSpatialExtents(buf, child, depth + 1));
        }
    }
    return found;
}

function hasBox(walk: BoxWalk, type: string): boolean {
    return walk.boxes.some(box => box.type === type);
}

/**
 * Reads the structure of a HEIC/HEIF file. Never throws: an unreadable file
 * comes back as `unknown` so the caller's decode reports it the usual way.
 */
export async function inspectHeifStructure(filePath: string, fileSize: number): Promise<HeifStructure> {
    let head: Buffer;
    try {
        const handle = await fs.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(fileSize, HEAD_BYTES));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            head = buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    } catch {
        return { kind: 'unknown' };
    }

    const top = walkBoxes(head, 0, fileSize);

    // Establish that this is a HEIF file before passing any judgement on it.
    // Reading the box lengths of something that is not a box tree produces
    // enormous sizes that reach well past the end of the file, which looks
    // exactly like truncation — so checking that first would report every
    // mislabelled or unrecognised .heic as a truncated photo instead of
    // handing it to the decoder, which is the only thing entitled to say.
    const ftyp = top.boxes.find(box => box.type === 'ftyp');
    if (!ftyp || ftyp.end > head.length) return { kind: 'unknown' };
    const brands: string[] = [];
    for (let at = ftyp.payloadStart; at + 4 <= ftyp.end; at += 4) {
        // Major brand, then the compatible-brand list (the four bytes of
        // minor version in between are not a brand, and never match).
        brands.push(head.toString('latin1', at, at + 4));
    }
    if (!brands.some(brand => HEIF_BRANDS.has(brand))) return { kind: 'unknown' };

    if (top.unreadable) return { kind: 'unknown' };
    if (top.truncated) {
        return { kind: 'damaged', detail: 'The HEIC file ends before its own structure does — it looks truncated.' };
    }

    const meta = top.boxes.find(box => box.type === 'meta');
    if (!meta) return { kind: 'unknown' };
    if (meta.end > head.length) return { kind: 'unknown' };

    const metaChildren = children(head, meta, 4);
    if (!metaChildren || metaChildren.unreadable) return { kind: 'unknown' };

    // Pixel data lives either in a top-level `mdat` or, for small items, in
    // an `idat` inside `meta`. Neither present means there is nothing to show.
    if (!hasBox(top, 'mdat') && !hasBox(metaChildren, 'idat')) {
        return { kind: 'damaged', detail: 'The HEIC file declares no image data.' };
    }

    const extents = collectSpatialExtents(head, meta, 0);
    const usable = extents.filter(e => e.width > 0 && e.height > 0);
    if (usable.length === 0) return { kind: 'unknown' };

    // A HEIC holds several items — thumbnails, and the tiles of a grid — each
    // with its own `ispe`. The largest is the picture the app will show, and
    // "the first one" is specifically wrong: a 4032x3024 photo out of Apple's
    // own encoder leads with its 512x512 tile extent.
    const largest = usable.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    return { kind: 'intact', width: largest.width, height: largest.height };
}

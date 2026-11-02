/**
 * Box-header parsing for the ISO base media file format.
 *
 * `.mp4`, `.mov` and `.heic` are all the same container: a tree of
 * length-prefixed boxes. Two readers in this app walk that tree for
 * different reasons and, more importantly, with different access patterns —
 * `heifStructure.ts` reads a photo's whole metadata region out of the head
 * of the file, while `videoStructure.ts` has to seek, because a video's
 * `moov` can sit behind a multi-gigabyte `mdat`. Only the header parsing is
 * common, and it is the fiddly part: the 32-bit size field has two escapes,
 * and getting either wrong turns an intact file into a corrupt one.
 */

export interface BoxHeader {
    /** Four-character box type, e.g. `ftyp`, `moov`, `mdat`. */
    type: string;
    /** Bytes of header before the payload: 8 normally, 16 with a 64-bit size. */
    headerSize: number;
    /** Declared total size including the header, or null for "to end of file". */
    declaredSize: number | null;
}

/** Not enough bytes present to read a header at all. */
export const SHORT_HEADER = 'short';
/** A size field that cannot describe a real box. */
export const INVALID_HEADER = 'invalid';

export type BoxHeaderResult = BoxHeader | typeof SHORT_HEADER | typeof INVALID_HEADER;

/**
 * Reads one box header at `at`. `buf` need only hold the header itself —
 * the payload may lie beyond it, which for `mdat` it almost always does.
 */
export function parseBoxHeader(buf: Buffer, at: number): BoxHeaderResult {
    if (at < 0 || at + 8 > buf.length) return SHORT_HEADER;

    const size32 = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);

    if (size32 === 1) {
        // The 64-bit escape: the real size follows the type.
        if (at + 16 > buf.length) return SHORT_HEADER;
        const large = buf.readBigUInt64BE(at + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return INVALID_HEADER;
        const declaredSize = Number(large);
        if (declaredSize < 16) return INVALID_HEADER;
        return { type, headerSize: 16, declaredSize };
    }

    // Zero means "to the end of the file", which only a last box may claim.
    if (size32 === 0) return { type, headerSize: 8, declaredSize: null };
    if (size32 < 8) return INVALID_HEADER;
    return { type, headerSize: 8, declaredSize: size32 };
}

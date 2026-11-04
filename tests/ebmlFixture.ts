/**
 * Synthetic EBML files, built element by element.
 *
 * Shared with `libraryHealth.test.ts`, which needs a `.webm` the scan can be
 * pointed at. The payloads are deliberately nonsense — no codec would make
 * anything of them — so an `intact` verdict can only have been reached by
 * reading the structure, which is the whole claim being tested.
 */

/** An element ID is written as its raw bytes, length marker included. */
export function idBytes(id: number): Buffer {
    const bytes: number[] = [];
    let rest = id;
    while (rest > 0) {
        bytes.unshift(rest & 0xff);
        rest = Math.floor(rest / 0x100);
    }
    return Buffer.from(bytes);
}

/** Values a size VINT of this width can hold — the width marker costs a bit. */
export const sizeCapacity = (width: number) => 2 ** (7 * width) - 1;

/**
 * A size VINT. The width is chosen to fit unless one is given, because real
 * muxers do not minimise it: ffmpeg writes the Segment's length in eight
 * bytes so it can be filled in after the fact, and a reader that only
 * handled the narrow form would reject every file it produces.
 *
 * The assertion is not decoration. The first version of this helper took a
 * width of 1 by default and silently wrote a 512-byte Cluster as a 0-byte
 * one, so seven tests failed against correct code and the fixture looked
 * like the innocent party.
 */
export function sizeBytes(value: number, width = 1): Buffer {
    if (value > sizeCapacity(width)) {
        throw new Error(`a ${width}-byte size VINT cannot hold ${value}`);
    }
    const bytes = Buffer.alloc(width);
    let rest = value;
    for (let i = width - 1; i >= 0; i--) {
        bytes[i] = rest & 0xff;
        rest = Math.floor(rest / 0x100);
    }
    bytes[0] |= 0x80 >> (width - 1);
    return bytes;
}

/** The narrowest width that can hold this length. */
export const widthFor = (value: number) => {
    for (let width = 1; width <= 8; width++) if (value <= sizeCapacity(width)) return width;
    throw new Error(`no size VINT can hold ${value}`);
};

/**
 * The "unknown size" encoding: the width marker, then every value bit set.
 * In one byte that is `0xff`; in eight it is `0x01` followed by seven
 * `0xff` — NOT eight `0xff`, which is a one-byte unknown size with seven
 * stray bytes after it.
 */
export function unknownSizeBytes(width = 1): Buffer {
    const bytes = Buffer.alloc(width, 0xff);
    bytes[0] = (0x80 >> (width - 1)) | (width === 8 ? 0 : 0xff >> width);
    return bytes;
}

export const element = (id: number, payload: Buffer, sizeWidth = widthFor(payload.length)) =>
    Buffer.concat([idBytes(id), sizeBytes(payload.length, sizeWidth), payload]);

export const openElement = (id: number, payload: Buffer) =>
    Buffer.concat([idBytes(id), unknownSizeBytes(), payload]);

export const ID_EBML = 0x1a45dfa3;
export const ID_SEGMENT = 0x18538067;
export const ID_SEEKHEAD = 0x114d9b74;
export const ID_INFO = 0x1549a966;
export const ID_TRACKS = 0x1654ae6b;
export const ID_CLUSTER = 0x1f43b675;
export const ID_VOID = 0xec;

export const ebmlHeader = () => element(ID_EBML, Buffer.alloc(31, 0x42));
export const tracks = () => element(ID_TRACKS, Buffer.alloc(92, 0x11));
export const cluster = (bytes = 512) => element(ID_CLUSTER, Buffer.alloc(bytes, 0x22));

/** Segment length in eight bytes, the way ffmpeg writes it. */
export const segment = (...children: Buffer[]) => element(ID_SEGMENT, Buffer.concat(children), 8);
export const webm = (...parts: Buffer[]) => Buffer.concat([ebmlHeader(), ...parts]);

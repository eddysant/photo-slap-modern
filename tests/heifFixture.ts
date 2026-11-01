/**
 * Synthetic HEIF files, built box by box.
 *
 * The point of these is that the pixel data is deliberately nonsense: a real
 * decoder would reject every one of them. Anything the structural check
 * calls `intact` here therefore proves it reached its verdict without
 * decoding, which is the whole claim being tested.
 */

export function box(type: string, payload: Buffer): Buffer {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
}

/** A box using the 64-bit size escape (size === 1) rather than the 32-bit field. */
export function largeBox(type: string, payload: Buffer): Buffer {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write(type, 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    return Buffer.concat([header, payload]);
}

export function ftyp(major: string, compatible: string[] = []): Buffer {
    return box('ftyp', Buffer.concat([
        Buffer.from(major, 'latin1'),
        Buffer.alloc(4), // minor version — four bytes that are not a brand
        ...compatible.map(brand => Buffer.from(brand, 'latin1')),
    ]));
}

export function ispe(width: number, height: number): Buffer {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(0, 0); // version + flags
    payload.writeUInt32BE(width, 4);
    payload.writeUInt32BE(height, 8);
    return box('ispe', payload);
}

/** `meta` carries a version/flags word ahead of its children. */
export function meta(...children: Buffer[]): Buffer {
    return box('meta', Buffer.concat([Buffer.alloc(4), ...children]));
}

export function properties(...extents: Buffer[]): Buffer {
    return box('iprp', box('ipco', Buffer.concat(extents)));
}

export function mdat(bytes = 4096): Buffer {
    return box('mdat', Buffer.alloc(bytes, 0x5a));
}

/** The shape a camera produces: a full-size image plus a thumbnail. */
export function heicFile(options: {
    brand?: string;
    compatible?: string[];
    extents?: Buffer[];
    data?: Buffer | null;
    metaBox?: Buffer | null;
} = {}): Buffer {
    const extents = options.extents ?? [ispe(4032, 3024), ispe(320, 240)];
    const metaBox = options.metaBox === undefined
        ? meta(properties(...extents))
        : options.metaBox;
    return Buffer.concat([
        ftyp(options.brand ?? 'heic', options.compatible ?? ['mif1', 'heic']),
        ...(metaBox ? [metaBox] : []),
        ...(options.data === null ? [] : [options.data ?? mdat()]),
    ]);
}

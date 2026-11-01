import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectHeifStructure } from '../electron/heifStructure';
import { ftyp, heicFile, ispe, largeBox, mdat, meta, properties } from './heifFixture';

describe('reading a HEIC without decoding it', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-heif-'));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const write = async (name: string, bytes: Buffer) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, bytes);
        return inspectHeifStructure(file, bytes.length);
    };

    it('reports the dimensions of a well-formed file', async () => {
        expect(await write('ok.heic', heicFile())).toEqual({ kind: 'intact', width: 4032, height: 3024 });
    });

    /**
     * A camera HEIC holds a thumbnail alongside the photo, and a grid image
     * holds a tile per cell. Picking the first `ispe` encountered would hand
     * the health check a 320x240 thumbnail and report the photo as "tiny".
     */
    it('takes the largest image in the file, not the first', async () => {
        const thumbnailFirst = heicFile({ extents: [ispe(320, 240), ispe(4032, 3024)] });
        expect(await write('thumb-first.heic', thumbnailFirst))
            .toEqual({ kind: 'intact', width: 4032, height: 3024 });
    });

    /**
     * The failure this check exists for: a copy that stopped, a sync that
     * died, a card pulled mid-write. The boxes say how long the file is, and
     * the file is shorter.
     */
    it('catches a file that ends before its own boxes do', async () => {
        const whole = heicFile();
        const cut = whole.subarray(0, whole.length - 512);
        const result = await write('truncated.heic', cut);
        expect(result.kind).toBe('damaged');
        expect(result).toHaveProperty('detail', expect.stringContaining('truncated'));
    });

    /** One byte short is still short; the boundary is where an off-by-one would hide. */
    it('catches a file that is a single byte short', async () => {
        const whole = heicFile();
        expect((await write('one-short.heic', whole.subarray(0, whole.length - 1))).kind).toBe('damaged');
    });

    it('does not cry truncation over a file that ends exactly on its last box', async () => {
        expect((await write('exact.heic', heicFile())).kind).toBe('intact');
    });

    it('reports a file carrying no image data at all', async () => {
        const result = await write('empty.heic', heicFile({ data: null }));
        expect(result.kind).toBe('damaged');
        expect(result).toHaveProperty('detail', expect.stringContaining('no image data'));
    });

    it('accepts item data stored inside meta instead of a top-level mdat', async () => {
        const inline = Buffer.concat([
            ftyp('heic', ['mif1']),
            meta(properties(ispe(1600, 1200)), Buffer.concat([
                Buffer.from([0, 0, 0, 12]), Buffer.from('idat', 'latin1'), Buffer.alloc(4, 0x11),
            ])),
        ]);
        expect(await write('inline.heic', inline)).toEqual({ kind: 'intact', width: 1600, height: 1200 });
    });

    it('follows the 64-bit size escape that large files use', async () => {
        const large = Buffer.concat([
            ftyp('heic', ['mif1']),
            meta(properties(ispe(8000, 6000))),
            largeBox('mdat', Buffer.alloc(2048, 0x7f)),
        ]);
        expect(await write('large.heic', large)).toEqual({ kind: 'intact', width: 8000, height: 6000 });
    });

    /**
     * Everything below must come back `unknown` rather than `damaged`. These
     * are files the parser does not understand, and calling them corrupt
     * would quarantine photos that open perfectly well — so the caller has to
     * get them back and run the real decoder.
     */
    describe('hands the decoder anything it cannot vouch for', () => {
        it('when the file is not HEIF at all', async () => {
            // A HEIF brand in the compatible list is enough, so this has to
            // claim none of them to be a non-HEIF file.
            const notHeif = heicFile({ brand: 'mp42', compatible: ['isom', 'avc1'] });
            expect((await write('mp4.heic', notHeif)).kind).toBe('unknown');
        });

        it('when there is no meta box to read properties from', async () => {
            expect((await write('nometa.heic', heicFile({ metaBox: null }))).kind).toBe('unknown');
        });

        it('when no box declares a spatial extent', async () => {
            expect((await write('noispe.heic', heicFile({ extents: [] }))).kind).toBe('unknown');
        });

        it('when an extent is declared as zero', async () => {
            expect((await write('zero.heic', heicFile({ extents: [ispe(0, 0)] }))).kind).toBe('unknown');
        });

        it('when a box size is nonsense', async () => {
            const bad = Buffer.concat([ftyp('heic'), Buffer.from([0, 0, 0, 2]), Buffer.from('meta', 'latin1')]);
            expect((await write('nonsense.heic', bad)).kind).toBe('unknown');
        });

        /**
         * Reading box lengths out of arbitrary bytes yields sizes that reach
         * far past the end of the file — the same signature as truncation. A
         * file this check cannot identify must come back `unknown`, or every
         * mislabelled .heic gets reported as a truncated photo.
         */
        it('when the bytes are not a box tree at all', async () => {
            expect((await write('garbage.heic', Buffer.from('this is not a photo'))).kind).toBe('unknown');
            expect((await write('random.heic', Buffer.alloc(9000, 0xc3))).kind).toBe('unknown');
        });

        it('when the file is empty', async () => {
            expect((await write('empty-file.heic', Buffer.alloc(0))).kind).toBe('unknown');
        });

        it('when the file is not there', async () => {
            expect(await inspectHeifStructure(path.join(dir, 'gone.heic'), 1024)).toEqual({ kind: 'unknown' });
        });
    });

    /**
     * The honest limit of this check, stated as a test so nobody mistakes it
     * for a decode. Every byte of pixel data in these fixtures is garbage and
     * the verdict is still `intact` — structural integrity is what is being
     * promised, not decodable pixels.
     */
    it('cannot tell that intact boxes hold rotten pixels', async () => {
        const garbage = heicFile({ data: mdat(1024) });
        expect((await write('plausible.heic', garbage)).kind).toBe('intact');
    });
});

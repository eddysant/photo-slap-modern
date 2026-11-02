import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectVideoStructure } from '../electron/videoStructure';
import { box, ftyp, largeBox, mdat } from './heifFixture';

/** ffmpeg writes exactly this: an empty `free` box, header and no payload. */
const freeBox = () => box('free', Buffer.alloc(0));
const moov = (bytes = 512) => box('moov', Buffer.alloc(bytes, 0x11));

const mp4 = (...boxes: Buffer[]) => Buffer.concat([ftyp('isom', ['mp42', 'avc1']), ...boxes]);

describe('reading a video without decoding it', () => {
    let dir: string;

    beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-vid-')); });
    afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    const write = async (name: string, bytes: Buffer) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, bytes);
        return inspectVideoStructure(file, bytes.length);
    };

    it('passes a well-formed file', async () => {
        expect((await write('ok.mp4', mp4(freeBox(), mdat(4096), moov()))).kind).toBe('intact');
    });

    /**
     * An empty box is legal and ordinary — ffmpeg writes a `free` of exactly
     * 8 bytes as padding. Treating a zero-length payload as nonsense called
     * every real mp4 unreadable, which is how this was found.
     */
    it('accepts the empty padding box ffmpeg writes', async () => {
        const withPadding = mp4(freeBox(), freeBox(), mdat(1024), moov());
        expect((await write('padded.mp4', withPadding)).kind).toBe('intact');
    });

    it('accepts the index before the media, as a faststart file has it', async () => {
        expect((await write('fast.mp4', mp4(moov(), mdat(4096)))).kind).toBe('intact');
    });

    /**
     * The whole point. An mp4 truncated to 30% of its bytes kept a valid
     * `ftyp` signature, so the old twelve-byte check reported it healthy.
     */
    it('catches a truncated file', async () => {
        const whole = mp4(mdat(8192), moov());
        const result = await write('cut.mp4', whole.subarray(0, Math.floor(whole.length * 0.3)));
        expect(result.kind).toBe('damaged');
        expect(result).toHaveProperty('detail', expect.stringContaining('truncated'));
    });

    it('catches a file that is a single byte short', async () => {
        const whole = mp4(mdat(2048), moov());
        expect((await write('short.mp4', whole.subarray(0, whole.length - 1))).kind).toBe('damaged');
    });

    /**
     * `moov` is the index. Without it no player can read the media at all,
     * and a download cut short is exactly what leaves this behind — the
     * boxes that did arrive are internally consistent.
     */
    it('catches a file whose index never arrived', async () => {
        const result = await write('noindex.mp4', mp4(mdat(4096)));
        expect(result.kind).toBe('damaged');
        expect(result).toHaveProperty('detail', expect.stringContaining('index'));
    });

    it('catches a file with an index but no media', async () => {
        const result = await write('nomedia.mp4', mp4(moov()));
        expect(result.kind).toBe('damaged');
        expect(result).toHaveProperty('detail', expect.stringContaining('no media data'));
    });

    it('follows the 64-bit size escape a large file uses', async () => {
        const large = Buffer.concat([ftyp('qt  ', ['qt  ']), largeBox('mdat', Buffer.alloc(2048, 7)), moov()]);
        expect((await write('large.mov', large)).kind).toBe('intact');
    });

    it('accepts a last box that runs to the end of the file', async () => {
        // size 0 means "to EOF"; only a final box may say so.
        const toEof = Buffer.concat([
            ftyp('isom'), moov(),
            Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('mdat', 'latin1'), Buffer.alloc(900, 3)]),
        ]);
        expect((await write('eof.mp4', toEof)).kind).toBe('intact');
    });

    /**
     * Anything not understood must come back `unknown`, never `damaged`:
     * calling a file corrupt is what gets it quarantined.
     */
    describe('declines to judge what it does not understand', () => {
        it('when the first box is not ftyp', async () => {
            expect((await write('odd.mp4', Buffer.concat([moov(), mdat(512)]))).kind).toBe('unknown');
        });

        it('when the bytes are not a box tree at all', async () => {
            expect((await write('junk.mp4', Buffer.alloc(9000, 0xc7))).kind).toBe('unknown');
        });

        it('when a size field is nonsense', async () => {
            const bad = Buffer.concat([ftyp('isom'), Buffer.from([0, 0, 0, 3]), Buffer.from('moov', 'latin1')]);
            expect((await write('bad.mp4', bad)).kind).toBe('unknown');
        });

        it('when the file is not there', async () => {
            expect(await inspectVideoStructure(path.join(dir, 'gone.mp4'), 4096)).toEqual({ kind: 'unknown' });
        });
    });

    it('calls a file too small to be a video damaged rather than unknown', async () => {
        const result = await write('tiny.mp4', Buffer.alloc(4));
        expect(result.kind).toBe('damaged');
    });

    /**
     * The honest limit, stated as a test: the boxes say the file arrived, not
     * that the frames inside it decode. A codec this machine cannot handle
     * still reads as intact here, which is what the stall watchdog and the
     * `onError` skip are for.
     */
    it('cannot tell that intact boxes hold undecodable frames', async () => {
        expect((await write('plausible.mp4', mp4(mdat(4096), moov()))).kind).toBe('intact');
    });
});

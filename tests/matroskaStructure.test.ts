import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    INVALID_ELEMENT, SHORT_ELEMENT,
    inspectMatroskaStructure, parseElementHeader,
} from '../electron/matroskaStructure';
import {
    ID_CLUSTER, ID_EBML, ID_INFO, ID_SEEKHEAD, ID_SEGMENT, ID_VOID,
    cluster, ebmlHeader, element, idBytes, openElement, segment, sizeBytes,
    tracks, unknownSizeBytes, webm,
} from './ebmlFixture';

// ---------- the walk ----------

describe('reading a Matroska file without decoding it', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-ebml-'));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const write = async (name: string, bytes: Buffer) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, bytes);
        return inspectMatroskaStructure(file, bytes.length);
    };

    it('accepts a well-formed file', async () => {
        expect(await write('ok.webm', webm(segment(
            element(ID_SEEKHEAD, Buffer.alloc(58)),
            element(ID_INFO, Buffer.alloc(48)),
            tracks(),
            cluster(),
        )))).toEqual({ kind: 'intact' });
    });

    /**
     * Found in real output before it was a test: ffmpeg writes a Void of its
     * own between the SeekHead and the Info, and a reader that could not step
     * over an element it does not recognise would lose the Tracks behind it.
     */
    it('steps over elements it has no interest in', async () => {
        expect(await write('void.webm', webm(segment(
            element(ID_VOID, Buffer.alloc(89, 0xff)),
            tracks(),
            cluster(),
        )))).toEqual({ kind: 'intact' });
    });

    it('accepts an empty element, which is legal', async () => {
        expect(await write('empty.webm', webm(segment(
            element(ID_VOID, Buffer.alloc(0)),
            tracks(),
            cluster(),
        )))).toEqual({ kind: 'intact' });
    });

    /** This is the file the whole check exists for. */
    it('catches a file cut short mid-element', async () => {
        const full = webm(segment(element(ID_INFO, Buffer.alloc(48)), tracks(), cluster(4096)));
        const cut = full.subarray(0, Math.floor(full.length * 0.3));
        expect(await write('cut.webm', cut)).toEqual({
            kind: 'damaged',
            detail: 'The video ends before its own structure does — it looks truncated.',
        });
    });

    it('catches a file one byte short of its own claim', async () => {
        const full = webm(segment(element(ID_INFO, Buffer.alloc(48)), tracks(), cluster()));
        expect(await write('short.webm', full.subarray(0, full.length - 1)))
            .toMatchObject({ kind: 'damaged' });
        expect(await write('exact.webm', full)).toEqual({ kind: 'intact' });
    });

    /**
     * Bytes left over at the top level that cannot form an element header:
     * the previous element's declared length landed short of the end of the
     * file. Reachable without any nesting, and the one truncation the
     * Segment-end and child checks cannot see — which a mutation test found,
     * by flipping this verdict to `unknown` and watching all 29 tests pass.
     */
    it('catches a stray fragment of an element at the top level', async () => {
        expect(await write('tail.webm', Buffer.concat([ebmlHeader(), Buffer.from([0x1a])])))
            .toEqual({
                kind: 'damaged',
                detail: 'The video ends before its own structure does — it looks truncated.',
            });
    });

    it('catches a download that stopped after the header', async () => {
        expect(await write('head.webm', ebmlHeader())).toEqual({
            kind: 'damaged',
            detail: 'The video holds nothing but its EBML header — it looks truncated.',
        });
    });

    /**
     * Tracks is the index — codec, resolution, which streams exist. Without
     * it nothing can play the file, and "no track information" and "no media
     * data" are different accidents, so they get different wording.
     */
    it('names a missing index and missing media separately', async () => {
        expect(await write('notracks.webm', webm(segment(element(ID_INFO, Buffer.alloc(48)), cluster()))))
            .toEqual({ kind: 'damaged', detail: 'The video is missing its track information and cannot be played.' });
        expect(await write('nomedia.webm', webm(segment(element(ID_INFO, Buffer.alloc(48)), tracks()))))
            .toEqual({ kind: 'damaged', detail: 'The video declares no media data.' });
    });

    it('calls an empty file what it is', async () => {
        expect(await write('empty.webm', Buffer.alloc(0))).toMatchObject({ kind: 'damaged' });
        expect(await write('tiny.webm', Buffer.alloc(3))).toMatchObject({ kind: 'damaged' });
    });

    /**
     * A muxer writing to a pipe cannot know how long its Segment will be, so
     * it writes the unknown-size encoding — every value bit set. Read as a
     * length that is 2^56-1 bytes, which looks exactly like truncation: this
     * is the ISO-BMFF lesson again, where alleging truncation before
     * establishing what the file is condemned every unrecognised one.
     */
    it('accepts an open-ended Segment, which live muxing produces', async () => {
        expect(await write('live.webm', webm(openElement(ID_SEGMENT, Buffer.concat([
            element(ID_INFO, Buffer.alloc(37)),
            tracks(),
            cluster(),
        ])))))
            .toEqual({ kind: 'intact' });
    });

    it('still catches truncation inside an open-ended Segment', async () => {
        const full = webm(openElement(ID_SEGMENT, Buffer.concat([tracks(), cluster(4096)])));
        expect(await write('livecut.webm', full.subarray(0, Math.floor(full.length * 0.3))))
            .toMatchObject({ kind: 'damaged' });
    });

    /** A Cluster may be open-ended too; what was already found still counts. */
    it('accepts an open-ended Cluster as the last thing in the file', async () => {
        expect(await write('liveclust.webm', webm(openElement(ID_SEGMENT, Buffer.concat([
            tracks(),
            openElement(ID_CLUSTER, Buffer.alloc(512, 0x22)),
        ])))))
            .toEqual({ kind: 'intact' });
    });

    describe('declines to judge what it does not understand', () => {
        it('a file that does not begin with the EBML header', async () => {
            expect(await write('mp4.webm', Buffer.concat([
                Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64),
            ]))).toEqual({ kind: 'unknown' });
        });

        it('bytes that are not an element tree at all', async () => {
            expect(await write('junk.webm', Buffer.alloc(4096, 0x41))).toEqual({ kind: 'unknown' });
        });

        it('a header whose ID byte describes no width', async () => {
            expect(await write('zero.webm', Buffer.concat([
                ebmlHeader(), Buffer.from([0x00, 0x81, 0x00]),
            ]))).toEqual({ kind: 'unknown' });
        });

        it('an open-ended element that is not a Segment', async () => {
            expect(await write('openvoid.webm', Buffer.concat([
                ebmlHeader(), openElement(ID_VOID, Buffer.alloc(32)),
            ]))).toEqual({ kind: 'unknown' });
        });

        it('a file that cannot be opened', async () => {
            expect(await inspectMatroskaStructure(path.join(dir, 'nope.webm'), 4096))
                .toEqual({ kind: 'unknown' });
        });
    });

    /**
     * The honest limit, stated as a test so nobody mistakes this for a
     * decode. Every element can be present and self-consistent while the VP9
     * or H.264 payload inside the Cluster is garbage — the same trade
     * `heifStructure` makes, for the same reason: there is no cheap check
     * that is also total. What this catches is a file that stopped arriving,
     * which is how a video in someone's library actually goes bad.
     */
    it('cannot tell that intact elements hold undecodable frames', async () => {
        expect(await write('rotten.webm', webm(segment(
            tracks(),
            element(ID_CLUSTER, Buffer.alloc(2048, 0x5a)), // not a frame in sight
        )))).toEqual({ kind: 'intact' });
    });
});

// ---------- the header parser ----------

describe('parseElementHeader', () => {
    it('reads a one-byte ID and a one-byte size', () => {
        expect(parseElementHeader(Buffer.from([0xec, 0x85]), 0))
            .toEqual({ id: 0xec, headerSize: 2, payloadSize: 5 });
    });

    it('reads a four-byte ID', () => {
        expect(parseElementHeader(Buffer.concat([idBytes(ID_EBML), sizeBytes(31)]), 0))
            .toEqual({ id: ID_EBML, headerSize: 5, payloadSize: 31 });
    });

    /** ffmpeg writes the Segment length in eight bytes, not the narrowest form. */
    it('reads a size that is not written in the narrowest form', () => {
        expect(parseElementHeader(Buffer.concat([idBytes(ID_SEGMENT), sizeBytes(12685, 8)]), 0))
            .toEqual({ id: ID_SEGMENT, headerSize: 12, payloadSize: 12685 });
    });

    it('reports the unknown size as unknown rather than as a huge one', () => {
        expect(parseElementHeader(Buffer.concat([idBytes(ID_SEGMENT), Buffer.from([0xff])]), 0))
            .toEqual({ id: ID_SEGMENT, headerSize: 5, payloadSize: null });
        // Wider forms encode it too: the marker, then every value bit set.
        expect(parseElementHeader(Buffer.concat([idBytes(ID_SEGMENT), unknownSizeBytes(8)]), 0))
            .toEqual({ id: ID_SEGMENT, headerSize: 12, payloadSize: null });
        // Eight 0xff bytes are NOT that: it is a one-byte unknown size with
        // seven stray bytes behind it, and reading it as eight would skip
        // seven bytes of whatever followed.
        expect(parseElementHeader(Buffer.concat([idBytes(ID_SEGMENT), Buffer.alloc(8, 0xff)]), 0))
            .toEqual({ id: ID_SEGMENT, headerSize: 5, payloadSize: null });
    });

    it('does not mistake an all-ones payload length for an unknown one', () => {
        // 0x81 0xff is a one-byte size of 1 followed by a payload byte, not an
        // unknown size: only the value bits of the size itself count.
        expect(parseElementHeader(Buffer.from([0xec, 0x81, 0xff]), 0))
            .toEqual({ id: 0xec, headerSize: 2, payloadSize: 1 });
    });

    it('refuses an ID wider than EBML allows', () => {
        expect(parseElementHeader(Buffer.from([0x08, 0x81, 0x81]), 0)).toBe(INVALID_ELEMENT);
        expect(parseElementHeader(Buffer.from([0x00, 0x81, 0x81]), 0)).toBe(INVALID_ELEMENT);
    });

    it('refuses a size byte that describes no width', () => {
        expect(parseElementHeader(Buffer.from([0xec, 0x00, 0x00]), 0)).toBe(INVALID_ELEMENT);
    });

    it('says when there are simply not enough bytes', () => {
        expect(parseElementHeader(Buffer.alloc(0), 0)).toBe(SHORT_ELEMENT);
        expect(parseElementHeader(Buffer.from([0xec]), 0)).toBe(SHORT_ELEMENT);
        expect(parseElementHeader(idBytes(ID_EBML), 0)).toBe(SHORT_ELEMENT);
        // An eight-byte size field with only four bytes present.
        expect(parseElementHeader(Buffer.concat([idBytes(ID_SEGMENT), Buffer.alloc(4, 0x01)]), 0))
            .toBe(SHORT_ELEMENT);
    });
});

// ---------- against what a real muxer writes ----------

/**
 * The synthetic fixtures above are written to the spec as I read it, which
 * is exactly how a reader comes to agree with its own assumptions. The mp4
 * sibling had a bug no synthetic fixture could have caught — ffmpeg's empty
 * `free` box — so these run against real output when ffmpeg is on the
 * machine, and skip rather than fail when it is not.
 */
const run = (args: string[]) => spawnSync('ffmpeg', ['-v', 'error', ...args]);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('against real ffmpeg output', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-ebml-real-'));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const SOURCE = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10'];

    /**
     * Fails loudly rather than returning quietly. ffmpeg is present — it was
     * checked — so an encode that does not happen is something to look at,
     * not a reason to report a passing test that examined nothing. (A build
     * without VP9 is a real possibility, hence the VP8 fallback; a build with
     * neither is worth knowing about.)
     */
    const encode = (name: string, codecs: string[]): string => {
        const file = path.join(dir, name);
        const failures: string[] = [];
        for (const codec of codecs) {
            const result = run([...SOURCE, '-c:v', codec, '-pix_fmt', 'yuv420p', '-b:v', '200k', file]);
            if (result.status === 0) return file;
            failures.push(`${codec}: ${String(result.stderr).trim().split('\n').pop()}`);
        }
        throw new Error(`ffmpeg could not write ${name} — ${failures.join('; ')}`);
    };

    const inspect = async (file: string) => {
        const { size } = await fs.stat(file);
        // A zero-length file would read as damaged and the test would pass
        // for entirely the wrong reason.
        expect(size).toBeGreaterThan(1024);
        return inspectMatroskaStructure(file, size);
    };

    it('calls a real .webm intact', async () => {
        expect(await inspect(encode('real.webm', ['libvpx-vp9', 'libvpx']))).toEqual({ kind: 'intact' });
    });

    it('calls a real .mkv intact', async () => {
        expect(await inspect(encode('real.mkv', ['libx264', 'mpeg4']))).toEqual({ kind: 'intact' });
    });

    /**
     * Piping is how the unknown-size Segment actually reaches a file, and it
     * is the case that would have had every live-muxed video in somebody's
     * library reported as corrupt had that encoding been read as a length.
     */
    it('calls a live-muxed .webm intact, and its Segment really is open-ended', async () => {
        const out = path.join(dir, 'stream.webm');
        const piped = spawnSync('sh', ['-c',
            `ffmpeg -v error ${SOURCE.join(' ')} -c:v libvpx-vp9 -b:v 200k -f webm pipe:1 `
            + `> ${JSON.stringify(out)}`]);
        if (piped.status !== 0) throw new Error(`piped ffmpeg failed: ${String(piped.stderr).trim()}`);

        // Without this the test could pass against a file whose Segment
        // carries an ordinary length, proving nothing about the encoding it
        // is here for.
        const head = await fs.readFile(out);
        const first = parseElementHeader(head, 0);
        expect(first).toMatchObject({ id: ID_EBML });
        if (typeof first === 'string') throw new Error('unreachable');
        const segment = parseElementHeader(head, first.headerSize + (first.payloadSize ?? 0));
        expect(segment).toMatchObject({ id: ID_SEGMENT, payloadSize: null });

        expect(await inspect(out)).toEqual({ kind: 'intact' });
    });

    it('catches a real .webm truncated mid-download', async () => {
        const bytes = await fs.readFile(encode('real.webm', ['libvpx-vp9', 'libvpx']));
        const cut = path.join(dir, 'cut.webm');
        await fs.writeFile(cut, bytes.subarray(0, Math.floor(bytes.length * 0.3)));
        expect(await inspect(cut)).toMatchObject({ kind: 'damaged' });
    });
});

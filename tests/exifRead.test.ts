import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    EXIF_HEAD_BYTES, EXIF_WHOLE_FILE_LIMIT, shouldReadWholeFile,
} from '../electron/exifRead';
import { SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS } from '../electron/fileScanner';

describe('shouldReadWholeFile', () => {
    it('reads on for an ordinary photo whose head held nothing', () => {
        expect(shouldReadWholeFile('/lib/a.jpg', 4 * 1024 * 1024)).toBe(true);
    });

    /**
     * The bug. `file:getExif` fell back to `readFile` with no bound, so a
     * 3.4GB video threw `ERR_FS_FILE_TOO_LARGE` from inside the handler —
     * and a file just under Node's 2GiB ceiling would have been read into
     * the main process in full instead.
     */
    it('refuses a file too large to hold in main', () => {
        expect(shouldReadWholeFile('/lib/huge.jpg', EXIF_WHOLE_FILE_LIMIT + 1)).toBe(false);
        expect(shouldReadWholeFile('/lib/huge.jpg', 3_466_559_938)).toBe(false);
    });

    it('allows a file exactly at the limit', () => {
        expect(shouldReadWholeFile('/lib/big.jpg', EXIF_WHOLE_FILE_LIMIT)).toBe(true);
    });

    // A video will never yield EXIF however much of it is read, so its size
    // is beside the point — this is excluded by kind, not by bulk.
    it('refuses a video whatever its size', () => {
        for (const ext of VIDEO_EXTENSIONS) {
            expect(shouldReadWholeFile(`/lib/clip${ext}`, 1024), ext).toBe(false);
        }
    });

    it('is case-insensitive about the extension', () => {
        expect(shouldReadWholeFile('/lib/CLIP.MOV', 1024)).toBe(false);
        expect(shouldReadWholeFile('/lib/CLIP.MKV', 1024)).toBe(false);
    });

    it('still reads on for every image format the scanner offers', () => {
        const images = [...SUPPORTED_EXTENSIONS].filter(e => !VIDEO_EXTENSIONS.has(e));
        expect(images.length).toBeGreaterThan(0);
        for (const ext of images) {
            expect(shouldReadWholeFile(`/lib/photo${ext}`, 1024), ext).toBe(true);
        }
    });

    // A file with no extension at all is not a video, and nothing says it
    // cannot be an image; the size bound is the only thing that should stop it.
    it('judges an extensionless file on size alone', () => {
        expect(shouldReadWholeFile('/lib/photo', 1024)).toBe(true);
        expect(shouldReadWholeFile('/lib/photo', EXIF_WHOLE_FILE_LIMIT + 1)).toBe(false);
    });

    it('reads a head far smaller than the fallback it guards', () => {
        expect(EXIF_HEAD_BYTES).toBeLessThan(EXIF_WHOLE_FILE_LIMIT);
    });
});

/**
 * Reads the source. `shouldReadWholeFile` is only worth anything if the
 * handler actually asks it, and the unbounded `readFile` it replaced is one
 * line that would restore the bug in full.
 */
describe('the EXIF handler asks before reading a file whole', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../electron/main.ts'), 'utf8');

    const body = (() => {
        const at = source.indexOf('async function readExifTags(');
        expect(at).toBeGreaterThan(-1);
        const end = source.indexOf('\nipcMain.handle(', at);
        expect(end).toBeGreaterThan(at);
        return source.slice(at, end);
    })();

    it('reads the whole file exactly once, and only there', () => {
        const whole = body.match(/fs\.readFile\(/g) ?? [];
        expect(whole).toHaveLength(1);
    });

    it('consults the guard before doing it', () => {
        const guard = body.indexOf('shouldReadWholeFile');
        const read = body.indexOf('fs.readFile(');
        expect(guard).toBeGreaterThan(-1);
        expect(read).toBeGreaterThan(guard);
    });

    it('takes the size from the handle it already opened, not a second stat', () => {
        expect(body).toContain('await fh.stat()');
        expect(body.match(/fs\.stat\(/g) ?? []).toHaveLength(0);
    });

    // The constants belong to the module that explains them.
    it('does not keep its own copy of the limits', () => {
        expect(source).toContain("from './exifRead'");
        expect(source).not.toMatch(/const EXIF_WHOLE_FILE_LIMIT\s*=/);
        expect(source).not.toMatch(/const EXIF_HEAD_BYTES\s*=/);
    });
});

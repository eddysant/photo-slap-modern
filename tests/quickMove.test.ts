import { describe, expect, it } from 'vitest';
import { folderLabel, moveReport } from '../src/quickMove';

describe('folderLabel', () => {
    it('names the folder, not the path to it', () => {
        expect(folderLabel('/Users/me/Photos/Keep')).toBe('Keep');
    });

    it('handles a Windows path', () => {
        expect(folderLabel('C:\\Users\\me\\Photos\\Later')).toBe('Later');
    });

    it('ignores a trailing separator', () => {
        expect(folderLabel('/Users/me/Photos/Keep/')).toBe('Keep');
    });

    // `split(…).pop()` returned '' here, so the toast read "Moved to ".
    it('falls back to the path itself when there is no last segment', () => {
        expect(folderLabel('/')).toBe('/');
    });
});

describe('moveReport', () => {
    const dest = '/Users/me/Photos/Keep';

    it('names the file count and the folder', () => {
        expect(moveReport({ moved: ['/a.jpg', '/b.jpg', '/c.jpg'], failed: [] }, dest))
            .toBe('Moved 3 to Keep');
    });

    it('does not say "1" for a single file', () => {
        expect(moveReport({ moved: ['/a.jpg'], failed: [] }, dest)).toBe('Moved to Keep');
    });

    /**
     * The whole reason this is one function. A partial move used to show two
     * toasts back to back, and a plain toast replaces the one before it — so a
     * batch where seven of eight files moved reported only the failure, within
     * a frame of reporting the success.
     */
    it('reports what moved and what did not, in one sentence', () => {
        expect(moveReport({ moved: ['/a.jpg', '/b.jpg'], failed: ['/c.jpg'] }, dest))
            .toBe('Moved 2 to Keep — 1 couldn\'t be moved');
    });

    it('counts several failures', () => {
        expect(moveReport({ moved: ['/a.jpg'], failed: ['/b.jpg', '/c.jpg'] }, dest))
            .toBe('Moved to Keep — 2 couldn\'t be moved');
    });

    it('says so plainly when nothing moved at all', () => {
        expect(moveReport({ moved: [], failed: ['/a.jpg'] }, dest))
            .toBe('Couldn\'t move that file to Keep');
        expect(moveReport({ moved: [], failed: ['/a.jpg', '/b.jpg'] }, dest))
            .toBe('Couldn\'t move 2 files to Keep');
    });
});

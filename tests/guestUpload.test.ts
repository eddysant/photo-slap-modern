import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { findFreeUploadPath, sanitizeUploadName, UPLOAD_EXTENSIONS } from '../electron/guestUpload';

describe('sanitizeUploadName', () => {
    it('keeps an ordinary photo name intact', () => {
        const result = sanitizeUploadName('IMG_4021.jpg');
        expect(result).toMatchObject({ ok: true, safeName: 'IMG_4021.jpg', stem: 'IMG_4021', ext: '.jpg', type: 'image' });
    });

    it('classifies videos by extension', () => {
        expect(sanitizeUploadName('clip.MOV')).toMatchObject({ ok: true, type: 'video', ext: '.mov' });
        expect(sanitizeUploadName('clip.webm')).toMatchObject({ ok: true, type: 'video' });
    });

    it('strips any directory component from a traversal attempt', () => {
        const result = sanitizeUploadName('../../../../etc/cron.d/pwned.jpg');
        expect(result.ok).toBe(true);
        expect(result.ok && result.safeName).toBe('pwned.jpg');
        expect(result.ok && result.safeName).not.toContain('/');
        expect(result.ok && result.safeName).not.toContain('..');
    });

    it('strips a Windows-style directory component', () => {
        const result = sanitizeUploadName('C:\\Windows\\System32\\evil.png');
        expect(result.ok).toBe(true);
        expect(result.ok && result.safeName).not.toContain('\\');
        expect(result.ok && result.safeName).not.toContain(':');
    });

    it('replaces shell-significant and control characters', () => {
        const result = sanitizeUploadName('a;rm -rf $HOME`whoami`.jpg');
        expect(result.ok).toBe(true);
        expect(result.ok && result.safeName).toMatch(/^[\w.\- ]+$/);
    });

    it('refuses an extension that is not whitelisted media', () => {
        for (const name of ['payload.sh', 'photo.jpg.exe', 'index.html', 'notes.txt', 'archive.zip']) {
            expect(sanitizeUploadName(name).ok).toBe(false);
        }
    });

    it('refuses a name with no extension at all', () => {
        expect(sanitizeUploadName('photo').ok).toBe(false);
    });

    it('refuses a dotfile whose whole name is the extension', () => {
        // ".jpg" has no stem — it would create a hidden file the scanner skips
        expect(sanitizeUploadName('.jpg').ok).toBe(false);
    });

    it('refuses names that are only dots', () => {
        expect(sanitizeUploadName('..').ok).toBe(false);
        expect(sanitizeUploadName('.').ok).toBe(false);
    });

    it('refuses empty and non-string input', () => {
        expect(sanitizeUploadName('').ok).toBe(false);
        expect(sanitizeUploadName('   ').ok).toBe(false);
        expect(sanitizeUploadName(undefined as unknown as string).ok).toBe(false);
    });

    it('accepts every whitelisted extension', () => {
        for (const ext of UPLOAD_EXTENSIONS) {
            expect(sanitizeUploadName(`photo${ext}`).ok).toBe(true);
        }
    });
});

describe('findFreeUploadPath', () => {
    const dir = '/library/guests';

    it('uses the plain name when nothing is there', async () => {
        const result = await findFreeUploadPath(dir, 'pic', '.jpg', async () => false);
        expect(result).toBe(path.join(dir, 'pic.jpg'));
    });

    it('never overwrites an existing file', async () => {
        const taken = new Set([path.join(dir, 'pic.jpg'), path.join(dir, 'pic-1.jpg')]);
        const result = await findFreeUploadPath(dir, 'pic', '.jpg', async c => taken.has(c));
        expect(result).toBe(path.join(dir, 'pic-2.jpg'));
    });
});

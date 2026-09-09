import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    allowRoot, isAllowedPath, assertAllowedPath, assertAllowedPaths, filterAllowedPaths,
    mediaUrlToPath, __resetAllowedRoots,
} from '../electron/pathAccess';
import { getFileUrl } from '../src/utils';

const ROOT = path.resolve('/tmp/photo-slap-test-library');

describe('allowlist', () => {
    beforeEach(() => {
        __resetAllowedRoots();
        allowRoot(ROOT);
    });

    it('serves files inside an opened folder', () => {
        expect(isAllowedPath(path.join(ROOT, 'a.jpg'))).toBe(true);
        expect(isAllowedPath(path.join(ROOT, 'nested', 'deep', 'b.jpg'))).toBe(true);
        expect(isAllowedPath(ROOT)).toBe(true);
    });

    it('refuses files outside every opened folder', () => {
        expect(isAllowedPath(path.resolve('/etc/passwd'))).toBe(false);
        expect(isAllowedPath(path.resolve('/tmp/other/a.jpg'))).toBe(false);
    });

    it('refuses a sibling directory sharing the root as a name prefix', () => {
        // "/tmp/photo-slap-test-library-private" must not match "/tmp/photo-slap-test-library"
        expect(isAllowedPath(`${ROOT}-private/secret.jpg`)).toBe(false);
    });

    it('resolves traversal before comparing, so ../ cannot escape', () => {
        expect(isAllowedPath(path.join(ROOT, '..', '..', 'etc', 'passwd'))).toBe(false);
        expect(isAllowedPath(`${ROOT}/nested/../a.jpg`)).toBe(true);
    });

    it('refuses everything when no folder has been opened', () => {
        __resetAllowedRoots();
        expect(isAllowedPath(path.join(ROOT, 'a.jpg'))).toBe(false);
    });

    it('treats empty and non-string input as disallowed', () => {
        expect(isAllowedPath('')).toBe(false);
        expect(() => assertAllowedPath('')).toThrow();
        expect(() => assertAllowedPath(undefined as unknown as string)).toThrow();
    });
});

describe('assertAllowedPath', () => {
    beforeEach(() => {
        __resetAllowedRoots();
        allowRoot(ROOT);
    });

    it('returns the resolved path for an allowed file', () => {
        expect(assertAllowedPath(`${ROOT}/nested/../a.jpg`)).toBe(path.join(ROOT, 'a.jpg'));
    });

    it('throws for a path outside the opened folders', () => {
        expect(() => assertAllowedPath('/etc/passwd')).toThrow(/outside the folders/);
    });

    it('rejects a whole batch if any entry is disallowed', () => {
        expect(() => assertAllowedPaths([path.join(ROOT, 'a.jpg'), '/etc/passwd'])).toThrow();
        expect(assertAllowedPaths([path.join(ROOT, 'a.jpg')])).toHaveLength(1);
    });

    it('filterAllowedPaths drops disallowed entries instead of throwing', () => {
        const kept = filterAllowedPaths([path.join(ROOT, 'a.jpg'), '/etc/passwd', '']);
        expect(kept).toEqual([path.join(ROOT, 'a.jpg')]);
    });
});

describe('mediaUrlToPath', () => {
    it('round-trips a URL built by getFileUrl', () => {
        const original = '/Users/me/my photos/#1 pick.jpg';
        expect(mediaUrlToPath(new URL(getFileUrl(original)))).toBe(original);
    });

    it('strips the leading slash from a Windows drive path', () => {
        expect(mediaUrlToPath(new URL('media://local/C%3A/Users/me/pic.jpg')))
            .toBe(path.normalize('C:/Users/me/pic.jpg'));
    });

    it('normalizes encoded traversal so the allowlist sees the real path', () => {
        const resolved = mediaUrlToPath(new URL('media://local/tmp/lib/..%2F..%2Fetc/passwd'));
        expect(resolved).not.toContain('..');
    });
});

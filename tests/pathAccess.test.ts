import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    allowRoot, isAllowedPath, assertAllowedPath, assertAllowedPaths, filterAllowedPaths,
    isWithin, mediaUrlToPath, __resetAllowedRoots,
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

/**
 * resolve() collapses "../" but knows nothing about links, so the allowlist
 * compares where a path really goes. Nothing legitimate is lost: the scanner
 * never offers a file reached through a symlink (see fileScanner.test.ts).
 */
describe('symlink escapes', () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        __resetAllowedRoots();
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-slap-root-'));
        outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-slap-outside-'));
        await fsp.writeFile(path.join(outside, 'secret.jpg'), 'x');
        allowRoot(root);
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(outside, { recursive: true, force: true });
    });

    it('refuses a file linked out of the opened folder', async () => {
        const link = path.join(root, 'innocent.jpg');
        await fsp.symlink(path.join(outside, 'secret.jpg'), link);
        expect(isAllowedPath(link)).toBe(false);
        expect(() => assertAllowedPath(link)).toThrow(/outside the folders/);
    });

    it('refuses a whole directory linked out of the opened folder', async () => {
        await fsp.symlink(outside, path.join(root, 'elsewhere'));
        expect(isAllowedPath(path.join(root, 'elsewhere', 'secret.jpg'))).toBe(false);
    });

    it('still serves real files, and paths that do not exist yet', async () => {
        await fsp.writeFile(path.join(root, 'real.jpg'), 'x');
        expect(isAllowedPath(path.join(root, 'real.jpg'))).toBe(true);
        // file:move names its destination before creating it.
        expect(isAllowedPath(path.join(root, 'keep', 'moved.jpg'))).toBe(true);
    });

    it('accepts a root that is itself a symlink, by either name', async () => {
        const linkedRoot = path.join(outside, 'library');
        await fsp.symlink(root, linkedRoot);
        await fsp.writeFile(path.join(root, 'real.jpg'), 'x');
        __resetAllowedRoots();
        allowRoot(linkedRoot);

        expect(isAllowedPath(path.join(linkedRoot, 'real.jpg'))).toBe(true);
        expect(isAllowedPath(path.join(root, 'real.jpg'))).toBe(true);
        expect(isAllowedPath(path.join(outside, 'secret.jpg'))).toBe(false);
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

describe('isWithin', () => {
    it('matches a file inside the directory, at any depth', () => {
        expect(isWithin('/lib', '/lib/a.jpg')).toBe(true);
        expect(isWithin('/lib', '/lib/nested/deep/a.jpg')).toBe(true);
        expect(isWithin('/lib', '/lib')).toBe(true);
    });

    it('does not match a sibling sharing the name as a prefix', () => {
        // The trailing separator is the whole point
        expect(isWithin('/lib', '/lib-private/secret.jpg')).toBe(false);
        expect(isWithin('/lib', '/library/a.jpg')).toBe(false);
    });

    it('does not match an unrelated path', () => {
        expect(isWithin('/lib', '/etc/passwd')).toBe(false);
    });

    it('is case-sensitive, unlike the security check', () => {
        // Ownership decisions feed path.relative(), which would produce
        // "../../a/b/c.jpg" if a differently-cased root were treated as a match.
        expect(isWithin('/Lib', '/lib/a.jpg')).toBe(false);
        expect(path.relative('/Lib', '/lib/a.jpg')).toContain('..');
    });
});

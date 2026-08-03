import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeSidecars, loadLibraryMeta, removeOrphanedLibraryMeta, saveLibraryMeta, SIDECAR_NAME } from '../electron/libraryMeta';

describe('mergeSidecars', () => {
    it('resolves relative paths against each sidecar directory', () => {
        const meta = mergeSidecars([
            { dir: '/lib', data: { version: 1, favorites: ['a.jpg', 'sub/b.jpg'] } },
        ]);
        expect(meta.favorites).toEqual([path.resolve('/lib/a.jpg'), path.resolve('/lib/sub/b.jpg')]);
    });

    it('lets the shallower sidecar win tags for the same file', () => {
        const meta = mergeSidecars([
            { dir: '/lib/sub', data: { version: 1, tags: { 'c.jpg': ['old'] } } },
            { dir: '/lib', data: { version: 1, tags: { 'sub/c.jpg': ['new'] } } },
        ]);
        expect(meta.tags[path.resolve('/lib/sub/c.jpg')]).toEqual(['new']);
    });

    it('unions the tag vocabulary', () => {
        const meta = mergeSidecars([
            { dir: '/a', data: { version: 1, tagNames: ['beach'] } },
            { dir: '/b', data: { version: 1, tagNames: ['family', 'beach'] } },
        ]);
        expect(meta.tagNames).toEqual(['beach', 'family']);
    });

    it('merges valid ratings and culling decisions', () => {
        const meta = mergeSidecars([
            { dir: '/lib', data: { version: 1, ratings: { 'a.jpg': 5, 'bad.jpg': 7 }, culling: { 'a.jpg': 'keep', 'b.jpg': 'reject' } } },
        ]);
        expect(meta.ratings).toEqual({ [path.resolve('/lib/a.jpg')]: 5 });
        expect(meta.culling).toEqual({ [path.resolve('/lib/a.jpg')]: 'keep', [path.resolve('/lib/b.jpg')]: 'reject' });
    });
});

describe('save/load round trip', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-lib-'));
        await fs.mkdir(path.join(root, 'sub'));
        await fs.writeFile(path.join(root, 'a.jpg'), 'x');
        await fs.writeFile(path.join(root, 'sub', 'b.jpg'), 'x');
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it('persists favorites and tags relative to the root sidecar', async () => {
        const meta = {
            favorites: [path.join(root, 'a.jpg')],
            tags: { [path.join(root, 'sub', 'b.jpg')]: ['beach'] },
            tagNames: ['beach'],
            ratings: { [path.join(root, 'a.jpg')]: 4 },
            culling: { [path.join(root, 'sub', 'b.jpg')]: 'keep' as const },
        };
        await saveLibraryMeta([root], meta);

        const loaded = await loadLibraryMeta([root]);
        expect(loaded.favorites).toEqual([path.join(root, 'a.jpg')]);
        expect(loaded.tags[path.join(root, 'sub', 'b.jpg')]).toEqual(['beach']);
        expect(loaded.tagNames).toEqual(['beach']);
        expect(loaded.ratings[path.join(root, 'a.jpg')]).toBe(4);
        expect(loaded.culling[path.join(root, 'sub', 'b.jpg')]).toBe('keep');
    });

    it('opening a parent picks up a sidecar saved in a subfolder', async () => {
        // Simulate the subfolder having been opened (and favorited in) before
        await saveLibraryMeta([path.join(root, 'sub')], {
            favorites: [path.join(root, 'sub', 'b.jpg')],
            tags: {},
            tagNames: ['old-tag'],
            ratings: {}, culling: {},
        });

        const loaded = await loadLibraryMeta([root]);
        expect(loaded.favorites).toEqual([path.join(root, 'sub', 'b.jpg')]);
        expect(loaded.tagNames).toEqual(['old-tag']);
    });

    it('writes entries back to their owning sidecar so unfavorites stick', async () => {
        // b.jpg favorited via the subfolder's own sidecar
        await saveLibraryMeta([path.join(root, 'sub')], {
            favorites: [path.join(root, 'sub', 'b.jpg')],
            tags: {},
            tagNames: [],
            ratings: {}, culling: {},
        });

        // Open the parent, unfavorite b, favorite a
        await saveLibraryMeta([root], {
            favorites: [path.join(root, 'a.jpg')],
            tags: {},
            tagNames: [],
            ratings: {}, culling: {},
        });

        const loaded = await loadLibraryMeta([root]);
        expect(loaded.favorites).toEqual([path.join(root, 'a.jpg')]); // b did not resurrect

        // The subfolder sidecar itself was rewritten, not just the root's
        const subSidecar = JSON.parse(await fs.readFile(path.join(root, 'sub', SIDECAR_NAME), 'utf8'));
        expect(subSidecar.favorites).toEqual([]);
    });

    it('does not litter folders that have nothing to record', async () => {
        await saveLibraryMeta([root], { favorites: [], tags: {}, tagNames: [], ratings: {}, culling: {} });
        await expect(fs.access(path.join(root, SIDECAR_NAME))).rejects.toThrow();
    });

    it('removes orphaned entries from every metadata collection', async () => {
        const missing = path.join(root, 'gone.jpg');
        await saveLibraryMeta([root], {
            favorites: [missing], tags: { [missing]: ['gone'] }, tagNames: ['gone'],
            ratings: { [missing]: 1 }, culling: { [missing]: 'reject' },
        });
        expect(await removeOrphanedLibraryMeta([root])).toEqual([missing]);
        const loaded = await loadLibraryMeta([root]);
        expect(loaded).toEqual({ favorites: [], tags: {}, tagNames: ['gone'], ratings: {}, culling: {} });
    });
});

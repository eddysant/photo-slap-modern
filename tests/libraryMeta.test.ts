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

/**
 * `saveLibraryMeta` rewrites an existing sidecar even when the entries for
 * that root come out empty, because that is how clearing the last favorite
 * sticks. It cannot tell that apart from being handed another library's
 * metadata, so the caller has to pair the metadata with the roots it came
 * from. `MetaSnapshot` in `useLibraryMeta` is what guarantees that; this
 * pins the behaviour it is guarding against.
 */
describe('metadata must be saved against the roots it came from', () => {
    let here: string;
    let elsewhere: string;

    beforeEach(async () => {
        here = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-here-'));
        elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-elsewhere-'));
        await fs.writeFile(path.join(here, 'mine.jpg'), 'x');
        await fs.writeFile(path.join(elsewhere, 'theirs.jpg'), 'x');
    });

    afterEach(async () => {
        await fs.rm(here, { recursive: true, force: true });
        await fs.rm(elsewhere, { recursive: true, force: true });
    });

    it('erases a library handed metadata that belongs to a different one', async () => {
        await saveLibraryMeta([here], {
            favorites: [path.join(here, 'mine.jpg')], tags: {}, tagNames: ['holiday'], ratings: {}, culling: {},
        });
        expect((await loadLibraryMeta([here])).favorites).toEqual([path.join(here, 'mine.jpg')]);

        await saveLibraryMeta([here], {
            favorites: [path.join(elsewhere, 'theirs.jpg')], tags: {}, tagNames: [], ratings: {}, culling: {},
        });

        const after = await loadLibraryMeta([here]);
        expect(after.favorites).toEqual([]);
        expect(after.tagNames).toEqual([]);
    });

    it('keeps both libraries intact when each is saved against its own root', async () => {
        await saveLibraryMeta([here], {
            favorites: [path.join(here, 'mine.jpg')], tags: {}, tagNames: ['holiday'], ratings: {}, culling: {},
        });
        await saveLibraryMeta([elsewhere], {
            favorites: [path.join(elsewhere, 'theirs.jpg')], tags: {}, tagNames: ['work'], ratings: {}, culling: {},
        });

        expect((await loadLibraryMeta([here])).favorites).toEqual([path.join(here, 'mine.jpg')]);
        expect((await loadLibraryMeta([elsewhere])).favorites).toEqual([path.join(elsewhere, 'theirs.jpg')]);
    });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invalidateSidecarDirs, mergeSidecars, loadLibraryMeta, removeOrphanedLibraryMeta, saveLibraryMeta, SIDECAR_NAME } from '../electron/libraryMeta';

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

/**
 * Which directories hold a sidecar is remembered between saves, because
 * finding out means listing every directory in the library — 4.2ms of a
 * 5.7ms save on 240 directories locally, and a round trip each on a network
 * volume, on an 800ms debounce as hearts are pressed.
 *
 * Nothing here asserts "the glob did not run", which is not observable from
 * outside and would be a test of the implementation anyway. These pin the
 * behaviour the cache is allowed to have, including the one staleness it
 * deliberately admits.
 */
describe('remembering where the sidecars are', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-cache-'));
        // Module-level state: a test must not inherit another's discoveries.
        invalidateSidecarDirs();
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
        invalidateSidecarDirs();
    });

    const sub = async (name: string) => {
        const dir = path.join(root, name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'a.jpg'), 'x');
        return dir;
    };

    const read = async (dir: string) =>
        JSON.parse(await fs.readFile(path.join(dir, SIDECAR_NAME), 'utf8'));

    const favour = (files: string[]) => ({
        favorites: files, tags: {}, tagNames: [], ratings: {}, culling: {},
    });

    /** The cold path: nothing has loaded, so the save has to go and look. */
    it('finds an existing sidecar on a save with no load before it', async () => {
        const dir = await sub('2024');
        await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify({ version: 1, favorites: [] }));

        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        // The deeper sidecar owns the file, so it is stored relative to it.
        expect((await read(dir)).favorites).toEqual(['a.jpg']);
    });

    it('keeps writing to a sidecar it created itself', async () => {
        const dir = await sub('2024');
        await loadLibraryMeta([root]);
        // Nothing nested exists yet, so this lands in the root sidecar.
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(root)).favorites).toEqual([path.join('2024', 'a.jpg')]);

        // Now a sidecar appears in the subfolder because the app put it
        // there — opening that subfolder directly, say.
        await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));
        expect((await read(dir)).favorites).toEqual(['a.jpg']);

        // And the next save of the parent must know the deeper one is there,
        // or the entry would migrate back out of it.
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(dir)).favorites).toEqual(['a.jpg']);
        expect((await read(root)).favorites).toEqual([]);
    });

    /**
     * An emptied sidecar is still rewritten — that is how clearing the last
     * favourite in a subfolder sticks.
     */
    it('rewrites a sidecar it has emptied rather than leaving the old one', async () => {
        const dir = await sub('2024');
        await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));
        expect((await read(dir)).favorites).toEqual(['a.jpg']);

        await saveLibraryMeta([dir], favour([]));
        expect((await read(dir)).favorites).toEqual([]);
    });

    /**
     * The cache can believe in a sidecar the user has since deleted by hand.
     * Writing an empty one back would recreate a file they removed, so the
     * question is put to the filesystem rather than to the cache.
     */
    it('does not recreate a sidecar that has been deleted by hand', async () => {
        const dir = await sub('2024');
        await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));
        await fs.rm(path.join(dir, SIDECAR_NAME));

        await saveLibraryMeta([dir], favour([]));
        await expect(fs.access(path.join(dir, SIDECAR_NAME))).rejects.toThrow();
    });

    it('and forgets it, so a later entry goes to the root instead', async () => {
        const dir = await sub('2024');
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));
        await fs.rm(path.join(dir, SIDECAR_NAME));

        // This save sees the empty bucket for `dir`, finds no file, forgets
        // the directory...
        await saveLibraryMeta([root], favour([]));
        // ...so the entry now belongs to the root's own sidecar.
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(root)).favorites).toEqual([path.join('2024', 'a.jpg')]);
        await expect(fs.access(path.join(dir, SIDECAR_NAME))).rejects.toThrow();
    });

    /**
     * The staleness the cache admits, stated as a test so it is a decision
     * rather than a surprise: a sidecar that appears from outside the app is
     * not noticed until the next load. The entry goes to the shallower file,
     * which still loads back correctly — merging is shallowest-wins — and a
     * load puts the app back in step.
     */
    it('notices a sidecar that appeared from outside only at the next load', async () => {
        const dir = await sub('2024');
        await loadLibraryMeta([root]);

        // Something other than this app drops a sidecar in the subfolder.
        await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify({ version: 1, favorites: [] }));

        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(root)).favorites).toEqual([path.join('2024', 'a.jpg')]);

        // The merged view is right either way, which is why this is a
        // tolerable trade rather than a bug.
        expect((await loadLibraryMeta([root])).favorites).toEqual([path.join(dir, 'a.jpg')]);

        // And after that load, the deeper sidecar owns it again.
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(dir)).favorites).toEqual(['a.jpg']);
    });

    it('re-discovers after the cache is invalidated', async () => {
        const dir = await sub('2024');
        await loadLibraryMeta([root]);
        await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify({ version: 1, favorites: [] }));

        invalidateSidecarDirs([root]);
        await saveLibraryMeta([root], favour([path.join(dir, 'a.jpg')]));
        expect((await read(dir)).favorites).toEqual(['a.jpg']);
    });

    it('does not let one library answer for another', async () => {
        const other = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-cache2-'));
        try {
            const dir = await sub('2024');
            await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify({ version: 1, favorites: [] }));
            await loadLibraryMeta([root]);

            // A different root, never loaded: its own save must go and look
            // rather than inherit this one's directories.
            await fs.writeFile(path.join(other, 'b.jpg'), 'x');
            await saveLibraryMeta([other], favour([path.join(other, 'b.jpg')]));
            expect((await read(other)).favorites).toEqual(['b.jpg']);
            // And nothing was written into the first library.
            expect((await read(dir)).favorites).toEqual([]);
        } finally {
            await fs.rm(other, { recursive: true, force: true });
        }
    });

    /**
     * Two libraries open at once. A sidecar created in one must be recorded
     * against the roots that *contain* it and no others — recorded against
     * every cached root, it becomes a write candidate for the other library,
     * whose save then finds an empty bucket for it, sees the file exists,
     * and overwrites someone else's sidecar with nothing in it. A mutation
     * test found this: dropping the containment check left all twenty tests
     * passing.
     */
    it('does not make one library a write target for another', async () => {
        const other = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-cache3-'));
        try {
            const dir = await sub('2024');
            await fs.writeFile(path.join(other, 'b.jpg'), 'x');
            // Both libraries known to the cache, which is the precondition.
            await loadLibraryMeta([root]);
            await loadLibraryMeta([other]);

            // A save in the first library creates a nested sidecar.
            await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));
            expect((await read(dir)).favorites).toEqual(['a.jpg']);

            // A save in the second must not touch it.
            await saveLibraryMeta([other], favour([path.join(other, 'b.jpg')]));
            expect((await read(dir)).favorites).toEqual(['a.jpg']);
            expect((await read(other)).favorites).toEqual(['b.jpg']);
        } finally {
            await fs.rm(other, { recursive: true, force: true });
        }
    });

    /** Every sidecar is written, which parallel writes must not change. */
    it('writes every owning sidecar in one save', async () => {
        const dirs = await Promise.all(['a', 'b', 'c', 'd'].map(n => sub(n)));
        for (const dir of dirs) await saveLibraryMeta([dir], favour([path.join(dir, 'a.jpg')]));

        await saveLibraryMeta([root], {
            favorites: dirs.map(d => path.join(d, 'a.jpg')),
            tags: {}, tagNames: ['beach'], ratings: {}, culling: {},
        });
        for (const dir of dirs) {
            const data = await read(dir);
            expect(data.favorites).toEqual(['a.jpg']);
            expect(data.tagNames).toEqual(['beach']);
        }
    });
});

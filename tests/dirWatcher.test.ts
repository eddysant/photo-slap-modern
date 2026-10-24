import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    DirectoryWatcher, diffScan, isIgnoredWatchPath, scanForChanges, settleFiles,
    type WatchChange,
} from '../electron/dirWatcher';

const file = (p: string) => ({ name: path.basename(p), path: p, type: 'image' as const });

describe('diffScan', () => {
    it('reports files the scan found that we did not know about', () => {
        const change = diffScan(new Set(['/lib/a.jpg']), [file('/lib/a.jpg'), file('/lib/b.jpg')]);
        expect(change.added.map(f => f.path)).toEqual(['/lib/b.jpg']);
        expect(change.removed).toEqual([]);
    });

    it('reports known files the scan no longer finds', () => {
        const change = diffScan(new Set(['/lib/a.jpg', '/lib/b.jpg']), [file('/lib/a.jpg')]);
        expect(change.added).toEqual([]);
        expect(change.removed).toEqual(['/lib/b.jpg']);
    });

    it('says nothing when nothing moved', () => {
        const change = diffScan(new Set(['/lib/a.jpg']), [file('/lib/a.jpg')]);
        expect(change).toEqual({ added: [], removed: [] });
    });
});

describe('isIgnoredWatchPath', () => {
    // The app writes .photo-slap.json on an 800ms debounce as tags are
    // edited; without this it would re-scan the whole library each time.
    it('ignores the sidecar and anything else dot-prefixed', () => {
        expect(isIgnoredWatchPath('.photo-slap.json')).toBe(true);
        expect(isIgnoredWatchPath('trip/.photo-slap.json')).toBe(true);
        expect(isIgnoredWatchPath('.photo-slap-quarantine/corrupt.jpg')).toBe(true);
        expect(isIgnoredWatchPath('trip\\.hidden\\x.jpg')).toBe(true);
    });

    it('does not ignore real media', () => {
        expect(isIgnoredWatchPath('new.jpg')).toBe(false);
        expect(isIgnoredWatchPath('trip/new.jpg')).toBe(false);
    });

    it('does not ignore a nameless event — it could be anything', () => {
        expect(isIgnoredWatchPath(null)).toBe(false);
    });
});

describe('settleFiles', () => {
    const wait = async () => {};

    it('admits a file whose size held still', async () => {
        const stat = async () => ({ size: 1024 });
        expect(await settleFiles(['/lib/a.jpg'], { stat, wait })).toEqual(['/lib/a.jpg']);
    });

    it('holds back a file that is still growing', async () => {
        let size = 100;
        const stat = async () => ({ size: (size += 900) });
        expect(await settleFiles(['/lib/a.jpg'], { stat, wait })).toEqual([]);
    });

    it('holds back an empty file', async () => {
        const stat = async () => ({ size: 0 });
        expect(await settleFiles(['/lib/a.jpg'], { stat, wait })).toEqual([]);
    });

    it('holds back a file that cannot be stat-ed', async () => {
        const stat = async () => { throw new Error('ENOENT'); };
        expect(await settleFiles(['/lib/a.jpg'], { stat, wait })).toEqual([]);
    });
});

describe('scanForChanges', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-watch-'));
        await fs.writeFile(path.join(dir, 'existing.jpg'), 'x');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('finds media added since the last pass, including in subfolders', async () => {
        const known = new Set([path.join(dir, 'existing.jpg')]);
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xx');
        await fs.mkdir(path.join(dir, 'nested'));
        await fs.writeFile(path.join(dir, 'nested', 'deep.png'), 'xx');

        const change = await scanForChanges(dir, known);
        expect(change.added.map(f => f.name).sort()).toEqual(['deep.png', 'fresh.jpg']);
        expect(change.removed).toEqual([]);
        expect(change.writing).toBe(0);
    });

    it('ignores files the slideshow cannot play', async () => {
        const known = new Set([path.join(dir, 'existing.jpg')]);
        await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
        await fs.writeFile(path.join(dir, '.photo-slap.json'), '{}');

        expect((await scanForChanges(dir, known)).added).toEqual([]);
    });

    it('reports media that disappeared from disk', async () => {
        const known = new Set([path.join(dir, 'existing.jpg'), path.join(dir, 'gone.jpg')]);
        const change = await scanForChanges(dir, known);
        expect(change.removed).toEqual([path.join(dir, 'gone.jpg')]);
        expect(change.added).toEqual([]);
    });

    // A file copied in exists from its first byte. Admitting it mid-copy
    // would hand the slideshow a truncated image.
    it('holds back a file that is still being written, and says so', async () => {
        const known = new Set([path.join(dir, 'existing.jpg')]);
        await fs.writeFile(path.join(dir, 'copying.jpg'), 'x');

        const change = await scanForChanges(dir, known, async () => []);
        expect(change.added).toEqual([]);
        expect(change.writing).toBe(1);
    });
});

describe('DirectoryWatcher', () => {
    let dir: string;
    let changes: WatchChange[];
    let watcher: DirectoryWatcher;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-watcher-'));
        await fs.writeFile(path.join(dir, 'existing.jpg'), 'x');
        changes = [];
        watcher = new DirectoryWatcher(change => changes.push(change));
    });

    afterEach(async () => {
        watcher.close();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('watches the roots it is given and drops the ones it is not', async () => {
        const other = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-watcher-'));
        try {
            await watcher.watch([dir, other]);
            expect(watcher.watchedRoots().sort()).toEqual([dir, other].sort());

            await watcher.watch([dir]);
            expect(watcher.watchedRoots()).toEqual([dir]);

            await watcher.watch([]);
            expect(watcher.watchedRoots()).toEqual([]);
        } finally {
            await fs.rm(other, { recursive: true, force: true });
        }
    });

    // Seeding is the whole reason watch() scans before it watches: without
    // it the first pass would announce the entire library as new media.
    it('says nothing about the files that were already there', async () => {
        await watcher.watch([dir]);
        await watcher.rescan(dir);
        expect(changes).toEqual([]);
    });

    it('reports a file added after it started watching, once', async () => {
        await watcher.watch([dir]);
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xx');

        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);
        expect(changes[0].added.map(f => f.name)).toEqual(['fresh.jpg']);

        // A second pass must not re-announce it.
        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);
    });

    it('reports a file removed after it started watching, once', async () => {
        await watcher.watch([dir]);
        await fs.rm(path.join(dir, 'existing.jpg'));

        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);
        expect(changes[0].removed).toEqual([path.join(dir, 'existing.jpg')]);

        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);
    });

    it('says nothing for a root it is no longer watching', async () => {
        await watcher.watch([dir]);
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xx');
        await watcher.watch([]);

        await watcher.rescan(dir);
        expect(changes).toEqual([]);
    });
});

describe('DirectoryWatcher.acknowledge', () => {
    let dir: string;
    let changes: WatchChange[];
    let watcher: DirectoryWatcher;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-ack-'));
        await fs.writeFile(path.join(dir, 'existing.jpg'), 'x');
        changes = [];
        watcher = new DirectoryWatcher(change => changes.push(change));
        await watcher.watch([dir]);
    });

    afterEach(async () => {
        watcher.close();
        await fs.rm(dir, { recursive: true, force: true });
    });

    // A quick-move target ("Keep/", "Later/") often lives inside the library.
    // Without this the photo the user just filed away rejoins the show.
    it('keeps quiet about a file the app itself put inside a root', async () => {
        await fs.mkdir(path.join(dir, 'keep'));
        const moved = path.join(dir, 'keep', 'filed.jpg');
        await fs.writeFile(moved, 'xx');
        watcher.acknowledge(moved);

        await watcher.rescan(dir);
        expect(changes).toEqual([]);
    });

    it('still reports anything it was not told about', async () => {
        await fs.writeFile(path.join(dir, 'acked.jpg'), 'xx');
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xx');
        watcher.acknowledge(path.join(dir, 'acked.jpg'));

        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);
        expect(changes[0].added.map(f => f.name)).toEqual(['fresh.jpg']);
    });

    it('ignores a path outside every watched root', async () => {
        expect(() => watcher.acknowledge(path.join(os.tmpdir(), 'elsewhere.jpg'))).not.toThrow();
    });
});

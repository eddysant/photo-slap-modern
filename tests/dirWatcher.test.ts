import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    DirectoryWatcher, RecentAdmissions, diffScan, findGrownFiles, isIgnoredWatchPath,
    scanForChanges, settleFiles, type WatchChange,
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
    const settled = async (stat: () => Promise<{ size: number }>) =>
        [...(await settleFiles(['/lib/a.jpg'], { stat, wait })).entries()];

    it('admits a file whose size held still, and says how big it was', async () => {
        // The size is what makes a stalled copy recoverable later.
        expect(await settled(async () => ({ size: 1024 }))).toEqual([['/lib/a.jpg', 1024]]);
    });

    it('holds back a file that is still growing', async () => {
        let size = 100;
        expect(await settled(async () => ({ size: (size += 900) }))).toEqual([]);
    });

    it('holds back an empty file', async () => {
        expect(await settled(async () => ({ size: 0 }))).toEqual([]);
    });

    it('holds back a file that cannot be stat-ed', async () => {
        expect(await settled(async () => { throw new Error('ENOENT'); })).toEqual([]);
    });
});

describe('RecentAdmissions', () => {
    it('remembers the size a file was admitted at', () => {
        const recent = new RecentAdmissions();
        recent.record('/lib/a.jpg', 2048);
        expect(recent.admittedSize('/lib/a.jpg')).toBe(2048);
        expect(recent.paths()).toEqual(['/lib/a.jpg']);
    });

    // The cap is what keeps a pass a handful of stats on a library of
    // thousands, however long the app has been running.
    it('keeps only the most recent admissions', () => {
        const recent = new RecentAdmissions(2);
        recent.record('/a.jpg', 1);
        recent.record('/b.jpg', 2);
        recent.record('/c.jpg', 3);
        expect(recent.paths()).toEqual(['/b.jpg', '/c.jpg']);
        expect(recent.admittedSize('/a.jpg')).toBeUndefined();
    });

    it('re-recording a file makes it the newest again', () => {
        const recent = new RecentAdmissions(2);
        recent.record('/a.jpg', 1);
        recent.record('/b.jpg', 2);
        recent.record('/a.jpg', 9);
        recent.record('/c.jpg', 3);
        expect(recent.paths()).toEqual(['/a.jpg', '/c.jpg']);
        expect(recent.admittedSize('/a.jpg')).toBe(9);
    });

    it('forgets a file on request', () => {
        const recent = new RecentAdmissions();
        recent.record('/a.jpg', 1);
        recent.forget('/a.jpg');
        expect(recent.paths()).toEqual([]);
    });
});

describe('findGrownFiles', () => {
    const recent = () => {
        const r = new RecentAdmissions();
        r.record('/lib/a.jpg', 1000);
        return r;
    };

    it('reports a file bigger than the one we admitted', async () => {
        expect(await findGrownFiles(recent(), async () => ({ size: 5000 }))).toEqual(['/lib/a.jpg']);
    });

    it('says nothing about a file that has not changed', async () => {
        expect(await findGrownFiles(recent(), async () => ({ size: 1000 }))).toEqual([]);
    });

    it('says nothing about a file that shrank or vanished', async () => {
        expect(await findGrownFiles(recent(), async () => ({ size: 400 }))).toEqual([]);
        expect(await findGrownFiles(recent(), async () => { throw new Error('ENOENT'); })).toEqual([]);
    });

    it('stats nothing when there is nothing recent', async () => {
        let stats = 0;
        await findGrownFiles(new RecentAdmissions(), async () => { stats++; return { size: 1 }; });
        expect(stats).toBe(0);
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

        const change = await scanForChanges(dir, known, { settle: async () => new Map() });
        expect(change.added).toEqual([]);
        expect(change.writing).toBe(1);
    });

    it('reports what each admitted file settled at', async () => {
        const known = new Set([path.join(dir, 'existing.jpg')]);
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xxxxx');

        const change = await scanForChanges(dir, known);
        expect(change.sizes.get(path.join(dir, 'fresh.jpg'))).toBe(5);
    });

    /**
     * Two size samples a beat apart catch a copy that is actively writing,
     * but not one that pauses across both — the partial file is admitted and
     * is `known` from then on, so the diff alone would never see it finish.
     */
    it('re-opens a known file that has grown since it was admitted', async () => {
        const truncated = path.join(dir, 'copying.jpg');
        await fs.writeFile(truncated, 'xx');
        const known = new Set([path.join(dir, 'existing.jpg'), truncated]);
        const recent = new RecentAdmissions();
        recent.record(truncated, 2);

        // Unchanged: the diff passed over it and so does the growth check.
        expect((await scanForChanges(dir, known, { recent })).added).toEqual([]);

        await fs.writeFile(truncated, 'xxxxxxxxxx');
        const change = await scanForChanges(dir, known, { recent });
        expect(change.added.map(f => f.name)).toEqual(['copying.jpg']);
        expect(change.sizes.get(truncated)).toBe(10);
    });

    it('leaves a grown file alone while it is still being written', async () => {
        const truncated = path.join(dir, 'copying.jpg');
        await fs.writeFile(truncated, 'xx');
        const known = new Set([path.join(dir, 'existing.jpg'), truncated]);
        const recent = new RecentAdmissions();
        recent.record(truncated, 1);

        const change = await scanForChanges(dir, known, { recent, settle: async () => new Map() });
        expect(change.added).toEqual([]);
        expect(change.writing).toBe(1); // so the caller comes round again
    });
});

describe('scanForChanges on a root it cannot fully read', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-unreadable-'));
        await fs.writeFile(path.join(dir, 'existing.jpg'), 'x');
        await fs.mkdir(path.join(dir, 'locked'));
        await fs.writeFile(path.join(dir, 'locked', 'inside.jpg'), 'x');
        await fs.chmod(path.join(dir, 'locked'), 0o000);
    });

    afterEach(async () => {
        await fs.chmod(path.join(dir, 'locked'), 0o755).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
    });

    /**
     * Libraries live on external drives and network shares. A transient read
     * error would otherwise report the whole library as gone, empty the show,
     * and then re-announce all of it as new media when the volume came back.
     */
    it('reports nothing as removed while any directory is unreadable', async () => {
        const known = new Set([
            path.join(dir, 'existing.jpg'),
            path.join(dir, 'locked', 'inside.jpg'),
        ]);
        const change = await scanForChanges(dir, known);
        expect(change.removed).toEqual([]);
    });

    it('still reports what it could actually see', async () => {
        await fs.writeFile(path.join(dir, 'fresh.jpg'), 'xx');
        const known = new Set([path.join(dir, 'existing.jpg')]);
        const change = await scanForChanges(dir, known);
        expect(change.added.map(f => f.name)).toEqual(['fresh.jpg']);
    });

    it('reports removals again once the directory is readable', async () => {
        await fs.chmod(path.join(dir, 'locked'), 0o755);
        await fs.rm(path.join(dir, 'locked'), { recursive: true });
        const known = new Set([
            path.join(dir, 'existing.jpg'),
            path.join(dir, 'locked', 'inside.jpg'),
        ]);
        const change = await scanForChanges(dir, known);
        expect(change.removed).toEqual([path.join(dir, 'locked', 'inside.jpg')]);
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

    /**
     * A copy that pauses across both size samples is admitted truncated, and
     * is `known` from then on. Only the growth check brings the finished
     * file back; before it, the file stayed broken until the next launch.
     */
    it('re-announces a file that grew after it was admitted', async () => {
        await watcher.watch([dir]);
        await fs.writeFile(path.join(dir, 'copying.jpg'), 'xx');

        await watcher.rescan(dir);
        expect(changes).toHaveLength(1);

        await fs.writeFile(path.join(dir, 'copying.jpg'), 'xxxxxxxxxx');
        await watcher.rescan(dir);
        expect(changes).toHaveLength(2);
        expect(changes[1].added.map(f => f.name)).toEqual(['copying.jpg']);

        // Once it is the whole file, it goes quiet again.
        await watcher.rescan(dir);
        expect(changes).toHaveLength(2);
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

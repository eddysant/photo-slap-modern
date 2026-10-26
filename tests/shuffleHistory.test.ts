import { describe, expect, it } from 'vitest';
import {
    getShuffleProgress, hasSeenEverything, makeShuffleHistoryKey, newShuffleSeed,
    orderForNoRepeatShuffle, recordViewed, reconcileShuffleOrder, retainShuffleOrder,
} from '../src/shuffleHistory';

const lib = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/lib/photo-${i}.jpg` }));
const SEED = 123456789;

describe('makeShuffleHistoryKey', () => {
    it('is stable regardless of the order the roots arrive in', () => {
        expect(makeShuffleHistoryKey(['/b', '/a'], 'both')).toBe(makeShuffleHistoryKey(['/a', '/b'], 'both'));
    });

    it('separates media filters', () => {
        expect(makeShuffleHistoryKey(['/a'], 'photos')).not.toBe(makeShuffleHistoryKey(['/a'], 'videos'));
    });
});

describe('orderForNoRepeatShuffle', () => {
    it('puts unseen items before seen ones', () => {
        const items = lib(6);
        const viewed = ['/lib/photo-0.jpg', '/lib/photo-1.jpg'];
        const { items: ordered } = orderForNoRepeatShuffle(items, viewed, SEED);
        const seenPositions = ordered.map((f, i) => viewed.includes(f.path) ? i : -1).filter(i => i >= 0);
        expect(Math.min(...seenPositions)).toBe(4);
    });

    it('keeps every item exactly once', () => {
        const { items: ordered } = orderForNoRepeatShuffle(lib(20), ['/lib/photo-3.jpg'], SEED);
        expect(new Set(ordered.map(f => f.path)).size).toBe(20);
    });

    it('starts a fresh cycle once everything has been viewed', () => {
        const items = lib(4);
        const result = orderForNoRepeatShuffle(items, items.map(f => f.path), SEED);
        expect(result.cycleReset).toBe(true);
        expect(result.viewedPaths).toEqual([]);
    });

    it('ignores viewed paths that are no longer in the library', () => {
        const { viewedPaths } = orderForNoRepeatShuffle(lib(3), ['/lib/photo-0.jpg', '/gone/old.jpg'], SEED);
        expect(viewedPaths).toEqual(['/lib/photo-0.jpg']);
    });

    it('gives the same order for the same seed', () => {
        const a = orderForNoRepeatShuffle(lib(30), [], SEED).items.map(f => f.path);
        const b = orderForNoRepeatShuffle(lib(30), [], SEED).items.map(f => f.path);
        expect(a).toEqual(b);
    });

    it('gives a different order for a different seed', () => {
        const a = orderForNoRepeatShuffle(lib(30), [], 1).items.map(f => f.path);
        const b = orderForNoRepeatShuffle(lib(30), [], 2).items.map(f => f.path);
        expect(a).not.toEqual(b);
    });

    it('actually shuffles rather than returning input order', () => {
        const items = lib(30);
        const ordered = orderForNoRepeatShuffle(items, [], SEED).items.map(f => f.path);
        expect(ordered).not.toEqual(items.map(f => f.path));
    });

    // The reported bug: deleting a photo re-randomised everything still queued.
    it('keeps the surviving order intact when an item is removed', () => {
        const items = lib(25);
        const before = orderForNoRepeatShuffle(items, [], SEED).items.map(f => f.path);
        const removed = before[7];
        const after = orderForNoRepeatShuffle(
            items.filter(f => f.path !== removed), [], SEED,
        ).items.map(f => f.path);
        expect(after).toEqual(before.filter(p => p !== removed));
    });

    it('keeps the surviving order intact across many removals', () => {
        const items = lib(40);
        const before = orderForNoRepeatShuffle(items, [], SEED).items.map(f => f.path);
        const gone = new Set([before[0], before[5], before[11], before[39]]);
        const after = orderForNoRepeatShuffle(
            items.filter(f => !gone.has(f.path)), [], SEED,
        ).items.map(f => f.path);
        expect(after).toEqual(before.filter(p => !gone.has(p)));
    });

    it('keeps the order stable when a viewed set grows, within each half', () => {
        const items = lib(20);
        const viewed = ['/lib/photo-2.jpg', '/lib/photo-9.jpg'];
        const first = orderForNoRepeatShuffle(items, viewed, SEED).items
            .filter(f => !viewed.includes(f.path)).map(f => f.path);
        const second = orderForNoRepeatShuffle(items, [...viewed, '/lib/photo-4.jpg'], SEED).items
            .filter(f => !viewed.includes(f.path) && f.path !== '/lib/photo-4.jpg').map(f => f.path);
        expect(second).toEqual(first.filter(p => p !== '/lib/photo-4.jpg'));
    });

    it('slots a newly added file in without disturbing the rest', () => {
        const items = lib(15);
        const before = orderForNoRepeatShuffle(items, [], SEED).items.map(f => f.path);
        const withGuest = [...items, { path: '/lib/guests/new.jpg' }];
        const after = orderForNoRepeatShuffle(withGuest, [], SEED).items.map(f => f.path);
        expect(after.filter(p => p !== '/lib/guests/new.jpg')).toEqual(before);
    });

    it('handles an empty library', () => {
        const result = orderForNoRepeatShuffle([], [], SEED);
        expect(result.items).toEqual([]);
        expect(result.cycleReset).toBe(false);
    });
});

describe('hasSeenEverything', () => {
    it('is false until every eligible item is viewed', () => {
        const items = lib(3);
        expect(hasSeenEverything(items, [])).toBe(false);
        expect(hasSeenEverything(items, ['/lib/photo-0.jpg', '/lib/photo-1.jpg'])).toBe(false);
        expect(hasSeenEverything(items, items.map(f => f.path))).toBe(true);
    });

    it('ignores viewed paths outside the library', () => {
        // Walking backwards onto the last slide must not look like a finished
        // cycle just because stale history mentions other files.
        expect(hasSeenEverything(lib(3), ['/gone/a.jpg', '/gone/b.jpg', '/gone/c.jpg'])).toBe(false);
    });

    it('is false for an empty library', () => {
        expect(hasSeenEverything([], [])).toBe(false);
    });
});

describe('recordViewed', () => {
    it('appends a new path and returns the same object when already present', () => {
        const history = recordViewed({}, 'k', '/a.jpg');
        expect(history.k).toEqual(['/a.jpg']);
        expect(recordViewed(history, 'k', '/a.jpg')).toBe(history);
    });
});

describe('getShuffleProgress', () => {
    it('counts only viewed items still in the library', () => {
        expect(getShuffleProgress(lib(4), ['/lib/photo-0.jpg', '/gone.jpg'])).toEqual({ viewed: 1, total: 4 });
    });
});

describe('newShuffleSeed', () => {
    it('produces a 32-bit unsigned integer', () => {
        const seed = newShuffleSeed();
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThanOrEqual(0xffffffff);
    });

    it('varies between calls', () => {
        expect(new Set(Array.from({ length: 50 }, () => newShuffleSeed())).size).toBeGreaterThan(40);
    });
});

describe('reconcileShuffleOrder', () => {
    const order = ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'];
    const filesFor = (paths: string[]) => paths.map(path => ({ path }));

    it('keeps surviving files exactly where they were', () => {
        // The reported bug: re-deriving after a delete re-partitioned the list
        // so everything already watched jumped to the back.
        const result = reconcileShuffleOrder(filesFor(['/a.jpg', '/c.jpg', '/d.jpg']), order, 7);
        expect(result.map(f => f.path)).toEqual(['/a.jpg', '/c.jpg', '/d.jpg']);
    });

    it('does not reorder when nothing changed', () => {
        expect(reconcileShuffleOrder(filesFor(order), order, 7).map(f => f.path)).toEqual(order);
    });

    it('is independent of the incoming array order', () => {
        const scrambled = filesFor(['/d.jpg', '/a.jpg', '/c.jpg', '/b.jpg']);
        expect(reconcileShuffleOrder(scrambled, order, 7).map(f => f.path)).toEqual(order);
    });

    it('puts newly appeared files first, since they cannot have been seen', () => {
        const result = reconcileShuffleOrder(filesFor([...order, '/guests/new.jpg']), order, 7);
        expect(result[0].path).toBe('/guests/new.jpg');
        expect(result.slice(1).map(f => f.path)).toEqual(order);
    });

    it('orders several new files deterministically by seed', () => {
        const withNew = filesFor([...order, '/n1.jpg', '/n2.jpg', '/n3.jpg']);
        const a = reconcileShuffleOrder(withNew, order, 7).map(f => f.path);
        const b = reconcileShuffleOrder(withNew, order, 7).map(f => f.path);
        expect(a).toEqual(b);
        expect(a.slice(3)).toEqual(order);
    });

    it('falls back to a seeded order when there is no previous one', () => {
        const result = reconcileShuffleOrder(filesFor(order), [], 7).map(f => f.path);
        expect([...result].sort()).toEqual([...order].sort());
    });

    it('handles an empty library', () => {
        expect(reconcileShuffleOrder([], order, 7)).toEqual([]);
    });
});

/**
 * The running order must not forget a path just because it left the list.
 * It did, and `reconcileShuffleOrder` then treated a photo that came back —
 * an undone delete, or one the Trash refused — as new media, putting it at
 * the front; the slideshow's pin followed it there and the viewer was thrown
 * to slide 1 on every such restore.
 */
describe('retainShuffleOrder', () => {
    const file = (p: string) => ({ path: p });

    it('keeps a path that dropped out of the list, where it was', () => {
        const previous = ['/a', '/b', '/c', '/d'];
        const current = ['/a', '/b', '/d']; // /c deleted
        expect(retainShuffleOrder(previous, current)).toEqual(previous);
    });

    it('keeps genuinely new paths at the front, ahead of the old order', () => {
        expect(retainShuffleOrder(['/a', '/b'], ['/new', '/a', '/b']))
            .toEqual(['/new', '/a', '/b']);
    });

    it('is the current order when there is no previous one', () => {
        expect(retainShuffleOrder([], ['/a', '/b'])).toEqual(['/a', '/b']);
    });

    it('returns the previous array unchanged when nothing is new', () => {
        const previous = ['/a', '/b'];
        // Same reference, so a ref holding it does not churn.
        expect(retainShuffleOrder(previous, ['/a'])).toBe(previous);
    });

    it('does not accumulate duplicates over repeated deletes', () => {
        let order = ['/a', '/b', '/c'];
        order = retainShuffleOrder(order, ['/a', '/c']);
        order = retainShuffleOrder(order, ['/a']);
        expect(order).toEqual(['/a', '/b', '/c']);
    });

    // The whole point: delete, then restore, and end up where you started.
    it('puts a restored file back at its own position, not the front', () => {
        const seed = 99;
        const all = ['/a', '/b', '/c', '/d', '/e'].map(file);
        const cycle = orderForNoRepeatShuffle(all, [], seed).items.map(f => f.path);
        const victim = cycle[3];

        const afterDelete = reconcileShuffleOrder(all.filter(f => f.path !== victim), cycle, seed);
        const retained = retainShuffleOrder(cycle, afterDelete.map(f => f.path));

        const afterRestore = reconcileShuffleOrder(all, retained, seed).map(f => f.path);
        expect(afterRestore.indexOf(victim)).toBe(3);
        expect(afterRestore).toEqual(cycle);
    });
});

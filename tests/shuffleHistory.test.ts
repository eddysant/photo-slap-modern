import { describe, expect, it } from 'vitest';
import { getShuffleProgress, makeShuffleHistoryKey, orderForNoRepeatShuffle, recordViewed, shuffleInPlace } from '../src/shuffleHistory';

const files = ['a', 'b', 'c', 'd'].map(path => ({ path }));

describe('no-repeat shuffle', () => {
    it('places every unseen file before files viewed in an earlier session', () => {
        const result = orderForNoRepeatShuffle(files, ['a', 'c'], () => 0.5);
        expect(result.items.slice(0, 2).map(f => f.path).sort()).toEqual(['b', 'd']);
        expect(result.items.slice(2).map(f => f.path).sort()).toEqual(['a', 'c']);
        expect(result.cycleReset).toBe(false);
    });

    it('starts a new cycle only after every eligible file has been seen', () => {
        const result = orderForNoRepeatShuffle(files, ['a', 'b', 'c', 'd'], () => 0.5);
        expect(result.cycleReset).toBe(true);
        expect(result.viewedPaths).toEqual([]);
        expect(result.items).toHaveLength(4);
    });

    it('deduplicates persisted history and isolates it by library and filter', () => {
        const key = makeShuffleHistoryKey(['/b', '/a'], 'photos');
        expect(key).toBe('/a|/b::photos');
        const once = recordViewed({}, key, 'a');
        expect(recordViewed(once, key, 'a')).toBe(once);
        expect(once[key]).toEqual(['a']);
    });

    it('reports unique eligible progress and ignores stale history', () => {
        expect(getShuffleProgress(files, ['a', 'a', 'c', 'missing'])).toEqual({ viewed: 2, total: 4 });
        expect(getShuffleProgress(files, [])).toEqual({ viewed: 0, total: 4 });
    });
});

describe('shuffleInPlace', () => {
    it('keeps exactly the same items', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const result = shuffleInPlace([...items]);
        expect([...result].sort((a, b) => a - b)).toEqual(items);
    });

    it('shuffles in place and returns the same array', () => {
        const items = [1, 2, 3];
        const result = shuffleInPlace(items);
        expect(result).toBe(items);
    });

    it('is driven entirely by the injected random source', () => {
        // A source that always returns 0 makes Fisher-Yates fully deterministic
        const a = shuffleInPlace([1, 2, 3, 4, 5], () => 0);
        const b = shuffleInPlace([1, 2, 3, 4, 5], () => 0);
        expect(a).toEqual(b);
    });

    it('handles empty and single-item arrays', () => {
        expect(shuffleInPlace([])).toEqual([]);
        expect(shuffleInPlace(['only'])).toEqual(['only']);
    });

    it('actually reorders with a real random source', () => {
        const items = Array.from({ length: 50 }, (_, i) => i);
        const shuffled = shuffleInPlace([...items]);
        expect(shuffled).not.toEqual(items); // 50! makes a no-op shuffle impossible in practice
    });
});

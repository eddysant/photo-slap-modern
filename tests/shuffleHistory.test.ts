import { describe, expect, it } from 'vitest';
import { getShuffleProgress, makeShuffleHistoryKey, orderForNoRepeatShuffle, recordViewed } from '../src/shuffleHistory';

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

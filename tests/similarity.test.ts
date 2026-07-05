import { describe, it, expect } from 'vitest';
import { groupSimilar, hammingDistance } from '../src/similarity';

const h = (path: string, hash: string) => ({ path, hash });

describe('hammingDistance', () => {
    it('counts differing positions', () => {
        expect(hammingDistance('0000', '0000')).toBe(0);
        expect(hammingDistance('0000', '0101')).toBe(2);
        expect(hammingDistance('1111', '0000')).toBe(4);
    });
});

describe('groupSimilar', () => {
    it('groups identical hashes', () => {
        const groups = groupSimilar([h('a', '1111'), h('b', '1111'), h('c', '0000')], 0);
        expect(groups).toEqual([['a', 'b']]);
    });

    it('is transitive: A~B and B~C put A, B, C in one group', () => {
        // threshold 1: a~b (dist 1), b~c (dist 1), but a-c dist 2
        const groups = groupSimilar([h('a', '0000'), h('b', '0001'), h('c', '0011')], 1);
        expect(groups).toHaveLength(1);
        expect(groups[0].sort()).toEqual(['a', 'b', 'c']);
    });

    it('keeps unrelated files out', () => {
        const groups = groupSimilar([h('a', '0000'), h('b', '0001'), h('x', '1111')], 1);
        expect(groups).toHaveLength(1);
        expect(groups[0]).not.toContain('x');
    });

    it('returns no groups when nothing matches', () => {
        expect(groupSimilar([h('a', '0000'), h('b', '1111')], 1)).toEqual([]);
    });

    it('handles empty input', () => {
        expect(groupSimilar([], 5)).toEqual([]);
    });
});

import { describe, expect, it } from 'vitest';
import { clampIndex, survivingNeighbourPath } from '../src/playlist';

const file = (name: string): MediaFile => ({ name, path: `/lib/${name}`, type: 'image' });
const files = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(file);

describe('clampIndex', () => {
    it('leaves an in-range index alone', () => {
        expect(clampIndex(2, 4)).toBe(2);
    });

    it('pulls an index past the end back to the last slide', () => {
        expect(clampIndex(9, 4)).toBe(3);
    });

    it('returns 0 for an empty list', () => {
        expect(clampIndex(3, 0)).toBe(0);
    });

    it('guards against negative and non-finite input', () => {
        expect(clampIndex(-1, 4)).toBe(0);
        expect(clampIndex(NaN, 4)).toBe(0);
    });
});

describe('survivingNeighbourPath', () => {
    it('moves forward to the next surviving slide', () => {
        const removed = new Set(['/lib/b.jpg']);
        expect(survivingNeighbourPath(files, 1, removed)).toBe('/lib/c.jpg');
    });

    it('walks forward past a run of deletions', () => {
        const removed = new Set(['/lib/b.jpg', '/lib/c.jpg']);
        expect(survivingNeighbourPath(files, 1, removed)).toBe('/lib/d.jpg');
    });

    it('falls back to the previous slide at the end of the list', () => {
        const removed = new Set(['/lib/d.jpg']);
        expect(survivingNeighbourPath(files, 3, removed)).toBe('/lib/c.jpg');
    });

    it('returns null when nothing survives', () => {
        const removed = new Set(files.map(f => f.path));
        expect(survivingNeighbourPath(files, 2, removed)).toBeNull();
    });

    it('keeps the current slide when something else was deleted', () => {
        const removed = new Set(['/lib/a.jpg']);
        expect(survivingNeighbourPath(files, 2, removed)).toBe('/lib/c.jpg');
    });

    it('handles an index already past the end', () => {
        expect(survivingNeighbourPath(files, 99, new Set(['/lib/d.jpg']))).toBe('/lib/c.jpg');
    });

    it('handles an empty list', () => {
        expect(survivingNeighbourPath([], 0, new Set())).toBeNull();
    });
});

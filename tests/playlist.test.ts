import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clampIndex, needsDateLookup, resolvePosition, survivingNeighbourPath } from '../src/playlist';

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

/**
 * One decision, for every rebuild of the playable list. The rule that matters
 * is that nothing lands on slide 1 by accident: three separate "it jumped
 * back to the beginning" bugs all came down to a fallback of 0.
 */
describe('resolvePosition', () => {
    it('lands on the pinned file wherever the rebuild put it', () => {
        expect(resolvePosition({ kind: 'path', path: '/lib/c.jpg' }, files, 0)).toBe(2);
    });

    it('honours a pinned index, clamped to the list', () => {
        expect(resolvePosition({ kind: 'index', index: 2 }, files, 0)).toBe(2);
        expect(resolvePosition({ kind: 'index', index: 99 }, files, 0)).toBe(3);
        expect(resolvePosition({ kind: 'index', index: -4 }, files, 0)).toBe(0);
    });

    // The hardening. A pinned file that is not in the new list means
    // something moved under us; "slide 1" is the one answer always wrong.
    it('stays near where the viewer was when the pinned file is missing', () => {
        expect(resolvePosition({ kind: 'path', path: '/lib/gone.jpg' }, files, 2)).toBe(2);
    });

    it('clamps rather than overshooting when the list also shrank', () => {
        expect(resolvePosition({ kind: 'path', path: '/lib/gone.jpg' }, files.slice(0, 2), 3)).toBe(1);
    });

    // No request at all is a new folder or a re-sort: the list the viewer was
    // looking at no longer means anything, so the beginning is right.
    it('starts at the beginning when nothing was asked for', () => {
        expect(resolvePosition(null, files, 3)).toBe(0);
    });

    it('is 0 for an empty list, whatever was asked for', () => {
        expect(resolvePosition({ kind: 'path', path: '/lib/a.jpg' }, [], 5)).toBe(0);
        expect(resolvePosition({ kind: 'index', index: 3 }, [], 5)).toBe(0);
        expect(resolvePosition(null, [], 5)).toBe(0);
    });

    // Deleting the slide you are on, over and over, is the case that broke.
    it('walks forward through repeated deletes without ever resetting', () => {
        let list = [...files];
        let index = 1;
        for (const victim of ['b.jpg', 'c.jpg', 'd.jpg']) {
            const pin = survivingNeighbourPath(list, index, new Set([`/lib/${victim}`]));
            list = list.filter(f => f.name !== victim);
            index = resolvePosition(pin === null ? null : { kind: 'path', path: pin }, list, index);
        }
        expect(list.map(f => f.name)).toEqual(['a.jpg']);
        expect(index).toBe(0); // only because nothing else survives
    });
});

describe('needsDateLookup', () => {
    it('reads dates for a date sort', () => {
        expect(needsDateLookup('date-desc', false)).toBe(true);
        expect(needsDateLookup('date-asc', false)).toBe(true);
    });

    it('does not read them for a name sort', () => {
        expect(needsDateLookup('name', false)).toBe(false);
    });

    /**
     * Shuffle throws the sorted order away, so reading the first 256 KB of
     * every file in the library to produce it is a gigabyte of I/O and a
     * "Reading photo dates…" toast spent on an order nobody will see.
     */
    it('does not read them under shuffle, whatever the sort says', () => {
        expect(needsDateLookup('date-desc', true)).toBe(false);
        expect(needsDateLookup('date-asc', true)).toBe(false);
        expect(needsDateLookup('name', true)).toBe(false);
    });
});

/** The saving is only real if App actually asks before fetching. */
describe('the derive asks before reading dates', () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');

    it('gates ensureDates on needsDateLookup', () => {
        expect(app).toMatch(/needsDateLookup\(sortOrder,\s*isShuffle\)\s*\?\s*await ensureDates\(/);
    });

    it('has no other call to ensureDates in the derive', () => {
        expect([...app.matchAll(/await ensureDates\(/g)]).toHaveLength(1);
    });
});

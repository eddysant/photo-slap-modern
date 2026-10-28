import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    applyLibraryFilters, clampIndex, filterByMediaType, needsDateLookup,
    resolvePosition, sortPlayable, survivingNeighbourPath,
} from '../src/playlist';

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
    const hook = fs.readFileSync(path.join(import.meta.dirname, '../src/hooks/usePlayableList.ts'), 'utf8');

    it('gates ensureDates on needsDateLookup', () => {
        expect(hook).toMatch(/needsDateLookup\(sortOrder,\s*isShuffle\)\s*\?\s*await ensureDates\(/);
    });

    it('has no other call to ensureDates in the derive', () => {
        expect([...hook.matchAll(/await ensureDates\(/g)]).toHaveLength(1);
    });
});

const media = (name: string, type: 'image' | 'video' = 'image'): MediaFile =>
    ({ name, path: `/lib/${name}`, type });

describe('filterByMediaType', () => {
    const mixed = [media('a.jpg'), media('b.mp4', 'video'), media('c.png')];

    it('admits everything when no type is asked for', () => {
        expect(filterByMediaType(mixed, 'all')).toHaveLength(3);
    });

    it('keeps only images for photos', () => {
        expect(filterByMediaType(mixed, 'photos').map(f => f.name)).toEqual(['a.jpg', 'c.png']);
    });

    it('keeps only videos for videos', () => {
        expect(filterByMediaType(mixed, 'videos').map(f => f.name)).toEqual(['b.mp4']);
    });
});

describe('applyLibraryFilters', () => {
    const list = [media('a.jpg'), media('b.jpg'), media('c.jpg')];
    const base = {
        favoritesOnly: false,
        favorites: new Set<string>(['/lib/b.jpg']),
        tagFilter: '',
        fileTags: { '/lib/a.jpg': ['trip'], '/lib/b.jpg': ['trip', 'dog'] },
    };

    it('passes everything through when nothing is on', () => {
        expect(applyLibraryFilters(list, base)).toEqual(list);
    });

    it('narrows to favorites', () => {
        expect(applyLibraryFilters(list, { ...base, favoritesOnly: true }).map(f => f.name))
            .toEqual(['b.jpg']);
    });

    it('narrows to a tag', () => {
        expect(applyLibraryFilters(list, { ...base, tagFilter: 'trip' }).map(f => f.name))
            .toEqual(['a.jpg', 'b.jpg']);
    });

    // Both, not whichever is checked first: a favorite that lacks the tag
    // must drop out, and so must a tagged file that is not a favorite.
    it('applies both filters together, not either', () => {
        const both = {
            ...base,
            favorites: new Set(['/lib/a.jpg', '/lib/b.jpg']),
            favoritesOnly: true,
            tagFilter: 'dog',
        };
        expect(applyLibraryFilters(list, both).map(f => f.name)).toEqual(['b.jpg']);
    });

    it('can narrow to nothing', () => {
        expect(applyLibraryFilters(list, { ...base, tagFilter: 'cat' })).toEqual([]);
    });

    it('treats a file with no tags as matching no tag filter', () => {
        expect(applyLibraryFilters(list, { ...base, tagFilter: 'trip' }).map(f => f.name))
            .not.toContain('c.jpg');
    });
});

describe('sortPlayable', () => {
    const unsorted = [media('IMG_10.jpg'), media('IMG_2.jpg'), media('IMG_1.jpg')];

    it('sorts by name naturally, not lexically', () => {
        expect(sortPlayable(unsorted, 'all', 'name', null).map(f => f.name))
            .toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
    });

    it('does not mutate its input', () => {
        const before = unsorted.map(f => f.name);
        sortPlayable(unsorted, 'all', 'name', null);
        expect(unsorted.map(f => f.name)).toEqual(before);
    });

    it('filters by media type before sorting', () => {
        const mixed = [media('b.mp4', 'video'), media('a.jpg')];
        expect(sortPlayable(mixed, 'photos', 'name', null).map(f => f.name)).toEqual(['a.jpg']);
    });

    it('sorts oldest first for date-asc', () => {
        const dates = { '/lib/IMG_1.jpg': 300, '/lib/IMG_2.jpg': 100, '/lib/IMG_10.jpg': 200 };
        expect(sortPlayable(unsorted, 'all', 'date-asc', dates).map(f => f.name))
            .toEqual(['IMG_2.jpg', 'IMG_10.jpg', 'IMG_1.jpg']);
    });

    it('sorts newest first for date-desc', () => {
        const dates = { '/lib/IMG_1.jpg': 300, '/lib/IMG_2.jpg': 100, '/lib/IMG_10.jpg': 200 };
        expect(sortPlayable(unsorted, 'all', 'date-desc', dates).map(f => f.name))
            .toEqual(['IMG_1.jpg', 'IMG_10.jpg', 'IMG_2.jpg']);
    });

    // The name pass is not redundant: without it two photos taken in the same
    // second order by whatever sequence the scan happened to return.
    it('breaks equal dates by name', () => {
        const dates = { '/lib/IMG_1.jpg': 100, '/lib/IMG_2.jpg': 100, '/lib/IMG_10.jpg': 100 };
        expect(sortPlayable(unsorted, 'all', 'date-desc', dates).map(f => f.name))
            .toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
    });

    it('treats a file with no date as the oldest there is', () => {
        const dates = { '/lib/IMG_1.jpg': 300, '/lib/IMG_2.jpg': 100 };
        expect(sortPlayable(unsorted, 'all', 'date-asc', dates).map(f => f.name)[0]).toBe('IMG_10.jpg');
    });

    it('keeps the name order when a date sort has no dates to use', () => {
        expect(sortPlayable(unsorted, 'all', 'date-desc', null).map(f => f.name))
            .toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
    });
});

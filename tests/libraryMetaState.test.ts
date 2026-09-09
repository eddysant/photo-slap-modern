import { describe, expect, it } from 'vitest';
import { pruneMetadata, toggleTag, type LibraryMetaState } from '../src/hooks/useLibraryMeta';

const state = (): LibraryMetaState => ({
    favorites: new Set(['/lib/a.jpg', '/lib/b.jpg']),
    fileTags: { '/lib/a.jpg': ['beach'], '/lib/b.jpg': ['dog'] },
    tagNames: ['beach', 'dog'],
    ratings: { '/lib/a.jpg': 5 },
    cullingDecisions: { '/lib/b.jpg': 'reject' },
});

describe('pruneMetadata', () => {
    it('removes a deleted file from every map', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg']);
        expect(next.favorites.has('/lib/a.jpg')).toBe(false);
        expect(next.fileTags['/lib/a.jpg']).toBeUndefined();
        expect(next.ratings['/lib/a.jpg']).toBeUndefined();
    });

    it('leaves other files untouched', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg']);
        expect(next.favorites.has('/lib/b.jpg')).toBe(true);
        expect(next.fileTags['/lib/b.jpg']).toEqual(['dog']);
        expect(next.cullingDecisions['/lib/b.jpg']).toBe('reject');
    });

    it('keeps the tag vocabulary — a tag outlives the photos using it', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg', '/lib/b.jpg']);
        expect(next.tagNames).toEqual(['beach', 'dog']);
    });

    it('returns the same object when nothing matched, so no save is scheduled', () => {
        const original = state();
        expect(pruneMetadata(original, [])).toBe(original);
        expect(pruneMetadata(original, ['/lib/never-existed.jpg'])).toBe(original);
    });
});

describe('toggleTag', () => {
    it('adds a tag that is not there', () => {
        expect(toggleTag({}, '/lib/a.jpg', 'beach')).toEqual({ '/lib/a.jpg': ['beach'] });
    });

    it('removes a tag that is', () => {
        const tags = { '/lib/a.jpg': ['beach', 'dog'] };
        expect(toggleTag(tags, '/lib/a.jpg', 'beach')).toEqual({ '/lib/a.jpg': ['dog'] });
    });

    it('drops the key entirely when the last tag is removed', () => {
        const result = toggleTag({ '/lib/a.jpg': ['beach'] }, '/lib/a.jpg', 'beach');
        expect('/lib/a.jpg' in result).toBe(false);
    });

    it('does not mutate the input', () => {
        const tags = { '/lib/a.jpg': ['beach'] };
        toggleTag(tags, '/lib/a.jpg', 'dog');
        expect(tags).toEqual({ '/lib/a.jpg': ['beach'] });
    });
});

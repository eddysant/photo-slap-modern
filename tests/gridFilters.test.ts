import { describe, expect, it } from 'vitest';
import { filterGridFiles, healthIssuesByPath, type GridFilterState } from '../src/gridFilters';

const files: MediaFile[] = [
    { name: 'Beach One.jpg', path: '/lib/a.jpg', type: 'image' },
    { name: 'Beach Two.jpg', path: '/lib/b.jpg', type: 'image' },
    { name: 'Party.mp4', path: '/lib/c.mp4', type: 'video' },
];

const baseFilters: GridFilterState = {
    query: '', favoritesOnly: false, tag: '', health: 'all', rating: 'all', culling: 'all',
};

describe('grid metadata filters', () => {
    it('combines filename, favorite, tag, health, rating, and culling predicates', () => {
        const result = filterGridFiles(files, {
            ...baseFilters, query: 'beach', favoritesOnly: true, tag: 'trip',
            health: 'healthy', rating: '5', culling: 'keep',
        }, {
            favorites: new Set(['/lib/a.jpg', '/lib/b.jpg']),
            tags: { '/lib/a.jpg': ['trip'], '/lib/b.jpg': ['trip'] },
            healthIssues: { '/lib/b.jpg': ['tiny'] },
            ratings: { '/lib/a.jpg': 5, '/lib/b.jpg': 5 },
            culling: { '/lib/a.jpg': 'keep', '/lib/b.jpg': 'keep' },
        });
        expect(result.map(item => item.file.path)).toEqual(['/lib/a.jpg']);
        expect(result[0].index).toBe(0);
    });

    it('supports unrated, unreviewed, and issue category filters', () => {
        const metadata = {
            favorites: new Set<string>(), tags: {}, healthIssues: { '/lib/c.mp4': ['corrupt' as const] },
            ratings: { '/lib/a.jpg': 3 }, culling: { '/lib/a.jpg': 'reject' as const },
        };
        expect(filterGridFiles(files, { ...baseFilters, rating: 'unrated', culling: 'unreviewed', health: 'corrupt' }, metadata)
            .map(item => item.file.path)).toEqual(['/lib/c.mp4']);
    });

    it('indexes multiple health findings per file without duplicates', () => {
        const report: LibraryHealthReport = {
            roots: ['/lib'], scannedFiles: 1,
            issues: [
                { category: 'tiny', path: '/lib/a.jpg', detail: 'tiny' },
                { category: 'missing-date', path: '/lib/a.jpg', detail: 'undated' },
                { category: 'tiny', path: '/lib/a.jpg', detail: 'duplicate finding' },
            ],
            summary: { corrupt: 0, tiny: 2, unsupported: 0, 'missing-date': 1, 'orphan-sidecar': 0 },
        };
        expect(healthIssuesByPath(report)).toEqual({ '/lib/a.jpg': ['tiny', 'missing-date'] });
    });
});

export type GridHealthFilter = 'all' | 'healthy' | 'issues' | LibraryHealthCategory;
export type GridRatingFilter = 'all' | 'unrated' | '1' | '2' | '3' | '4' | '5';
export type GridCullingFilter = 'all' | 'unreviewed' | CullingDecision;

export interface GridFilterState {
    query: string;
    favoritesOnly: boolean;
    tag: string;
    health: GridHealthFilter;
    rating: GridRatingFilter;
    culling: GridCullingFilter;
}

export interface GridFilterMetadata {
    favorites: Set<string>;
    tags: Record<string, string[]>;
    healthIssues: Record<string, LibraryHealthCategory[]> | null;
    ratings: Record<string, number>;
    culling: Record<string, CullingDecision>;
}

export function filterGridFiles(
    files: MediaFile[],
    filters: GridFilterState,
    metadata: GridFilterMetadata,
): { file: MediaFile; index: number }[] {
    const query = filters.query.trim().toLowerCase();
    return files
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => {
            if (query && !file.name.toLowerCase().includes(query)) return false;
            if (filters.favoritesOnly && !metadata.favorites.has(file.path)) return false;
            if (filters.tag && !metadata.tags[file.path]?.includes(filters.tag)) return false;
            if (filters.rating === 'unrated' && metadata.ratings[file.path]) return false;
            if (/^[1-5]$/.test(filters.rating) && metadata.ratings[file.path] !== Number(filters.rating)) return false;
            if (filters.culling === 'unreviewed' && metadata.culling[file.path]) return false;
            if ((filters.culling === 'keep' || filters.culling === 'reject') && metadata.culling[file.path] !== filters.culling) return false;
            if (filters.health !== 'all') {
                if (!metadata.healthIssues) return false;
                const issues = metadata.healthIssues[file.path] ?? [];
                if (filters.health === 'healthy' && issues.length > 0) return false;
                if (filters.health === 'issues' && issues.length === 0) return false;
                if (!['healthy', 'issues'].includes(filters.health) && !issues.includes(filters.health as LibraryHealthCategory)) return false;
            }
            return true;
        });
}

export function healthIssuesByPath(report: LibraryHealthReport | null): Record<string, LibraryHealthCategory[]> | null {
    if (!report) return null;
    const result: Record<string, LibraryHealthCategory[]> = {};
    for (const issue of report.issues) {
        const categories = result[issue.path] ?? [];
        if (!categories.includes(issue.category)) result[issue.path] = [...categories, issue.category];
    }
    return result;
}

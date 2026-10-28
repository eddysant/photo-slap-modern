/**
 * Pure helpers for keeping the slideshow's position sane while the playable
 * list changes underneath it (deletes, quick-moves, guest uploads, re-sorts).
 */

/** Clamp an index into a list, returning 0 for an empty one. */
export function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    if (!Number.isFinite(index) || index < 0) return 0;
    return Math.min(Math.trunc(index), length - 1);
}

/**
 * The path the slideshow should sit on after `removed` disappears from
 * `files`. Prefers the next surviving slide (so repeated deletes walk forward
 * through the library the way the user expects), then the previous one, and
 * returns null when nothing survives.
 *
 * Without this, removing a file changes `allFiles`, which re-derives the
 * playable list and resets the index to 0 — so every delete threw the user
 * back to the first photo.
 */
export function survivingNeighbourPath(
    files: readonly MediaFile[],
    currentIndex: number,
    removed: ReadonlySet<string>,
): string | null {
    for (let i = Math.max(0, currentIndex); i < files.length; i++) {
        if (!removed.has(files[i].path)) return files[i].path;
    }
    for (let i = Math.min(currentIndex, files.length) - 1; i >= 0; i--) {
        if (!removed.has(files[i].path)) return files[i].path;
    }
    return null;
}

/**
 * What the slideshow has been asked to land on once the playable list is
 * rebuilt. `null` is "nothing asked for".
 *
 * One request, not two flags with a precedence rule between them: the list is
 * re-derived on every delete, restore, quick-move, guest upload, filter and
 * sort change, and each of those wants exactly one of these answers.
 */
export type PendingPosition =
    | { kind: 'path'; path: string }
    | { kind: 'index'; index: number }
    | null;

/**
 * The index a freshly derived list should sit at.
 *
 * The case that matters is the last one. A pinned *path* that is missing from
 * the new list means something moved under us, and the one answer that is
 * always wrong there is 0 — "jump to the first slide" is precisely the bug
 * this machinery exists to prevent. Clamping the position the viewer already
 * had degrades to "near where you were" instead.
 *
 * With no request at all, 0 is right: that is a new folder or a re-sort, where
 * the list the viewer was looking at no longer means anything.
 */
export function resolvePosition(
    pending: PendingPosition,
    list: readonly { path: string }[],
    previousIndex: number,
): number {
    if (list.length === 0) return 0;
    if (pending === null) return 0;
    if (pending.kind === 'index') return clampIndex(pending.index, list.length);
    const found = list.findIndex(file => file.path === pending.path);
    return found >= 0 ? found : clampIndex(previousIndex, list.length);
}

/**
 * Whether the playable list actually needs date-taken data.
 *
 * A date sort does — but shuffle replaces the order outright afterwards
 * (`reconcileShuffleOrder` and the seeded rank depend on nothing but the
 * paths and the seed), so under shuffle the sort is discarded and reading
 * dates is pure waste. It is not cheap waste: `files:getDates` reads the
 * first 256 KB of every file in the library looking for an EXIF
 * `DateTimeOriginal`, which is over a gigabyte of I/O on a few thousand
 * photos, and it puts a "Reading photo dates…" toast in front of someone
 * whose order is about to be randomised anyway.
 */
export function needsDateLookup(sortOrder: string, isShuffle: boolean): boolean {
    return sortOrder !== 'name' && !isShuffle;
}

// A reused Collator is ~20x faster than per-call localeCompare(…, options),
// which matters when sorting libraries with tens of thousands of files.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Which files a media-type filter admits. */
export function filterByMediaType<T extends { type: string }>(files: readonly T[], mediaFilter: string): readonly T[] {
    if (mediaFilter === 'photos') return files.filter(f => f.type === 'image');
    if (mediaFilter === 'videos') return files.filter(f => f.type === 'video');
    return files;
}

export interface LibraryFilters {
    favoritesOnly: boolean;
    favorites: ReadonlySet<string>;
    tagFilter: string;
    fileTags: Readonly<Record<string, string[]>>;
}

/** The favourites / tag filters, which narrow what the show draws from. */
export function applyLibraryFilters<T extends { path: string }>(
    files: readonly T[],
    { favoritesOnly, favorites, tagFilter, fileTags }: LibraryFilters,
): readonly T[] {
    let visible = files;
    if (favoritesOnly) visible = visible.filter(f => favorites.has(f.path));
    if (tagFilter) visible = visible.filter(f => fileTags[f.path]?.includes(tagFilter));
    return visible;
}

/**
 * The playable list in order, before shuffle gets a say.
 *
 * Name order runs first unconditionally: for a name sort it is the answer,
 * and for a date sort it is the tiebreaker, so two photos taken in the same
 * second are not ordered by whatever sequence the scan happened to return.
 * Without dates a date sort cannot be applied, and the name order stands.
 */
export function sortPlayable<T extends { path: string; name: string; type: string }>(
    unfiltered: readonly T[],
    mediaFilter: string,
    sort: string,
    dates: Readonly<Record<string, number>> | null,
): T[] {
    const sorted = [...filterByMediaType(unfiltered, mediaFilter)]
        .sort((a, b) => nameCollator.compare(a.name, b.name));

    if (sort !== 'name' && dates) {
        sorted.sort((a, b) => {
            const da = dates[a.path] ?? 0;
            const db = dates[b.path] ?? 0;
            return sort === 'date-desc' ? db - da : da - db;
        });
    }
    return sorted;
}

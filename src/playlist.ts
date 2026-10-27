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

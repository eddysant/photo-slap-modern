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

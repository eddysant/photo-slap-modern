/** The last segment of a path, for naming a quick-move target in a toast. */
export function folderLabel(destDir: string): string {
    const parts = destDir.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : destDir;
}

export interface MoveOutcome {
    moved: string[];
    failed: string[];
}

/**
 * One sentence for a batch move, however it went.
 *
 * It is one sentence because it has to be. A partial move used to show two
 * toasts back to back, and a plain toast replaces the one before it — so
 * "Moved 7 to Keep" was wiped out by "1 file(s) could not be moved" within a
 * frame, and a batch where most files moved reported only the failure.
 */
export function moveReport(outcome: MoveOutcome, destDir: string): string {
    const where = folderLabel(destDir);
    const { moved, failed } = outcome;

    if (moved.length === 0) {
        return failed.length === 1
            ? `Couldn't move that file to ${where}`
            : `Couldn't move ${failed.length} files to ${where}`;
    }

    const sent = moved.length === 1 ? `Moved to ${where}` : `Moved ${moved.length} to ${where}`;
    if (failed.length === 0) return sent;
    return failed.length === 1
        ? `${sent} — 1 couldn't be moved`
        : `${sent} — ${failed.length} couldn't be moved`;
}

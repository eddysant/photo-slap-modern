import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a delete can be taken back before it actually reaches the Trash. */
export const UNDO_WINDOW_MS = 7_000;

/**
 * Why files are going back into the slideshow. The caller needs to tell these
 * apart: an undo is what the user just asked for, while a trash that failed is
 * a surprise they have had no explanation for.
 */
export type RestoreReason = 'undo' | 'trash-failed';

/** A file the Trash would not take, and what it said about why. */
export interface RefusedTrash {
    file: MediaFile;
    reason?: string;
}

interface PendingDeletesOptions {
    /** Take these files out of the slideshow right away. */
    onRemoved: (files: MediaFile[]) => void;
    /**
     * Put them back — the user changed their mind, or the Trash refused them.
     * `why` carries the OS's explanation for a refusal, when it gave one.
     */
    onRestored: (files: MediaFile[], reason: RestoreReason, why?: string) => void;
}

/**
 * The sentence the user actually reads when a delete is refused.
 *
 * It is a pure function so the wording can be tested. The reason matters
 * more than the apology: "permission denied" is something the user can act
 * on, and for one release this message was not shown at all.
 */
export function trashFailureMessage(files: MediaFile[], why?: string): string {
    const what = files.length === 1
        ? `Couldn't move ${files[0].name} to the Trash`
        : `Couldn't move ${files.length} files to the Trash`;
    const because = why?.trim() ? ` — ${cleanTrashReason(why)}` : '';
    return `${what}${because}. ${files.length === 1 ? "It's" : "They're"} still in the show.`;
}

/**
 * Reduces an OS trash error to the part the user does not already know.
 *
 * macOS answers with a whole sentence that repeats the filename back, in
 * curly quotes: “t2.jpg” couldn’t be moved to the trash because you don’t
 * have permission to access it. Pasted into a toast that already names the
 * file, that reads as two sentences saying the same thing. Everything after
 * "because" is the only new information in it, so that is what is kept.
 * Other platforms bake the full path in instead, which is stripped.
 */
export function cleanTrashReason(raw: string): string {
    const because = /\bbecause\s+(.+)/is.exec(raw);
    const core = because ? because[1] : raw.replace(/\s*'?\/[^\s']*'?/g, '');
    const text = (core.replace(/\s{2,}/g, ' ').trim() || raw).replace(/[.\s]+$/, '');
    const short = text.length > 90 ? `${text.slice(0, 89)}…` : text;
    return short.charAt(0).toLowerCase() + short.slice(1);
}

/**
 * Deferred deletion with an undo window.
 *
 * `shell.trashItem` cannot be reversed from the app (only by the user, in
 * Finder), so the file is removed from the slideshow immediately but the
 * actual trashing is held for a few seconds. That is the only point at which
 * an undo is possible, and it makes Backspace — a single unconfirmed
 * keystroke that used to destroy a photo instantly — recoverable.
 *
 * Anything still pending when the window closes is flushed, so quitting the
 * app never silently cancels a delete the user asked for.
 */
/**
 * Trash each file, returning the ones that did not make it.
 *
 * A refusal is ordinary, not exceptional: an external drive formatted exFAT
 * has no `.Trashes`, so macOS declines every one of them. The caller puts the
 * survivors back in the slideshow, because they are still on disk.
 *
 * Sequential on purpose — `shell.trashItem` against one volume gains nothing
 * from being run in parallel, and the order files come back in matters.
 */
export async function trashFiles(
    files: MediaFile[],
    trash: (path: string) => Promise<TrashOutcome>,
): Promise<RefusedTrash[]> {
    const failed: RefusedTrash[] = [];
    for (const file of files) {
        const outcome = await trash(file.path)
            .catch((e: unknown) => ({ ok: false as const, reason: (e as Error)?.message }));
        if (!outcome.ok) failed.push({ file, reason: outcome.reason });
    }
    return failed;
}

export function usePendingDeletes({ onRemoved, onRestored }: PendingDeletesOptions) {
    const [pending, setPending] = useState<MediaFile[] | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingRef = useRef<MediaFile[] | null>(null);

    // The callbacks are held in refs so the functions this hook returns stay
    // referentially stable. Callers pass inline arrows, and an unstable
    // `requestDelete` propagates into App's keydown and menu:action effects,
    // which then re-register their listeners on every render.
    const onRemovedRef = useRef(onRemoved);
    const onRestoredRef = useRef(onRestored);
    useEffect(() => { onRemovedRef.current = onRemoved; }, [onRemoved]);
    useEffect(() => { onRestoredRef.current = onRestored; }, [onRestored]);

    const trashNow = useCallback(
        (files: MediaFile[]) => trashFiles(files, path => window.api.deleteFile(path)),
        []);

    /** Commit whatever is pending immediately. */
    const flush = useCallback(async () => {
        const files = pendingRef.current;
        if (!files) return [];
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingRef.current = null;
        setPending(null);
        const failed = await trashNow(files);
        // A file that could not be trashed is still gone from the slideshow;
        // put it back so the list matches the disk.
        if (failed.length > 0) {
            onRestoredRef.current(failed.map(f => f.file), 'trash-failed', failed[0].reason);
        }
        return failed;
    }, [trashNow]);

    const requestDelete = useCallback((files: MediaFile[]) => {
        if (files.length === 0) return;
        // Only one batch can be undone at a time; committing the previous one
        // keeps the model simple and the toast honest.
        const previous = pendingRef.current;
        if (previous) {
            if (timerRef.current) clearTimeout(timerRef.current);
            pendingRef.current = null;
            void trashNow(previous).then(failed => {
                if (failed.length > 0) {
                    onRestoredRef.current(failed.map(f => f.file), 'trash-failed', failed[0].reason);
                }
            });
        }

        onRemovedRef.current(files);
        pendingRef.current = files;
        setPending(files);
        timerRef.current = setTimeout(() => { void flush(); }, UNDO_WINDOW_MS);
    }, [trashNow, flush]);

    const undo = useCallback(() => {
        const files = pendingRef.current;
        if (!files) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingRef.current = null;
        setPending(null);
        onRestoredRef.current(files, 'undo');
    }, []);

    // Never let a quit or reload cancel a delete the user asked for.
    useEffect(() => {
        const commitOnExit = () => {
            const files = pendingRef.current;
            if (!files) return;
            pendingRef.current = null;
            void trashNow(files);
        };
        window.addEventListener('beforeunload', commitOnExit);
        return () => {
            window.removeEventListener('beforeunload', commitOnExit);
            if (timerRef.current) clearTimeout(timerRef.current);
            commitOnExit();
        };
    }, [trashNow]);

    return { pending, requestDelete, undo, flush };
}

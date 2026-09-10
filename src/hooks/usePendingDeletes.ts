import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a delete can be taken back before it actually reaches the Trash. */
export const UNDO_WINDOW_MS = 7_000;

interface PendingDeletesOptions {
    /** Take these files out of the slideshow right away. */
    onRemoved: (files: MediaFile[]) => void;
    /** Put them back — the user changed their mind inside the window. */
    onRestored: (files: MediaFile[]) => void;
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

    const trashNow = useCallback(async (files: MediaFile[]) => {
        const failed: MediaFile[] = [];
        for (const file of files) {
            const ok = await window.api.deleteFile(file.path).catch(() => false);
            if (!ok) failed.push(file);
        }
        return failed;
    }, []);

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
        if (failed.length > 0) onRestoredRef.current(failed);
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
                if (failed.length > 0) onRestoredRef.current(failed);
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
        onRestoredRef.current(files);
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

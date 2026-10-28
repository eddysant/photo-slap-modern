import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastAction } from '../components/Toast';

/** How long a toast stays up when the caller doesn't say otherwise. */
export const TOAST_DURATION_MS = 4000;

export interface ToastState {
    message: string | null;
    action: ToastAction | null;
}

/**
 * The transient notice at the bottom of the window, and the one rule that
 * makes it more than a string: **a toast carrying an action is not
 * replaceable**.
 *
 * The Undo affordance after a delete lives only in its own toast, so a
 * passing status message arriving inside that window — "Skipping X, it can't
 * be displayed", a folder that joined the show — would take Undo away
 * mid-window with nothing to replace it. Those messages are dropped instead.
 * A toast that carries its own action still wins, because it is something
 * the user is being offered rather than something passing by.
 */
export function useToast() {
    const [toast, setToast] = useState<ToastState>({ message: null, action: null });
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** When the actionable toast now showing stops protecting itself. */
    const protectedUntil = useRef(0);

    const clearTimer = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    };

    const show = useCallback((
        message: string,
        action: ToastAction | null = null,
        durationMs = TOAST_DURATION_MS,
    ) => {
        if (!action && Date.now() < protectedUntil.current) return;
        protectedUntil.current = action ? Date.now() + durationMs : 0;
        setToast({ message, action });
        clearTimer();
        timer.current = setTimeout(() => {
            timer.current = null;
            protectedUntil.current = 0;
            setToast({ message: null, action: null });
        }, durationMs);
    }, []);

    const dismiss = useCallback(() => {
        clearTimer();
        protectedUntil.current = 0;
        setToast({ message: null, action: null });
    }, []);

    useEffect(() => clearTimer, []);

    return { toast, showToast: show, dismissToast: dismiss };
}

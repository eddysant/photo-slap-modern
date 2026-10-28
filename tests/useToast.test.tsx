// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, useToast } from '../src/hooks/useToast';

const undo = { label: 'Undo', onAction: () => {} };

describe('useToast', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    it('starts with nothing showing', () => {
        const { result } = renderHook(() => useToast());
        expect(result.current.toast).toEqual({ message: null, action: null });
    });

    it('shows a message and clears it when the time is up', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Saved'); });
        expect(result.current.toast.message).toBe('Saved');
        act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS); });
        expect(result.current.toast.message).toBeNull();
    });

    it('a plain message replaces a plain message', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('First'); });
        act(() => { result.current.showToast('Second'); });
        expect(result.current.toast.message).toBe('Second');
    });

    /**
     * The rule the hook exists for. Undo lives only in its own toast, so a
     * passing status message must not take it away mid-window.
     */
    it('will not let a passing message replace one carrying an action', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Deleted a.jpg', undo); });
        act(() => { result.current.showToast("Skipping b.jpg — it can't be displayed"); });
        expect(result.current.toast.message).toBe('Deleted a.jpg');
        expect(result.current.toast.action).toBe(undo);
    });

    it('lets another actionable toast through, because that is also an offer', () => {
        const { result } = renderHook(() => useToast());
        const second = { label: 'Undo', onAction: () => {} };
        act(() => { result.current.showToast('Deleted a.jpg', undo); });
        act(() => { result.current.showToast('Deleted b.jpg', second); });
        expect(result.current.toast.action).toBe(second);
    });

    it('accepts a plain message again once the protected one has gone', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Deleted a.jpg', undo); });
        act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS); });
        act(() => { result.current.showToast('Skipping b.jpg'); });
        expect(result.current.toast.message).toBe('Skipping b.jpg');
    });

    it('protects for exactly as long as the toast is up', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Deleted a.jpg', undo, 1000); });
        act(() => { vi.advanceTimersByTime(999); });
        act(() => { result.current.showToast('Passing by'); });
        expect(result.current.toast.message).toBe('Deleted a.jpg');
        act(() => { vi.advanceTimersByTime(1); });
        act(() => { result.current.showToast('Passing by'); });
        expect(result.current.toast.message).toBe('Passing by');
    });

    /** Taking the action closes the toast, and stops it protecting itself. */
    it('dismiss clears the toast and the protection with it', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Deleted a.jpg', undo); });
        act(() => { result.current.dismissToast(); });
        expect(result.current.toast).toEqual({ message: null, action: null });
        act(() => { result.current.showToast('Skipping b.jpg'); });
        expect(result.current.toast.message).toBe('Skipping b.jpg');
    });

    it('a dismissed toast does not come back to clear a newer one', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('Deleted a.jpg', undo); });
        act(() => { result.current.dismissToast(); });
        act(() => { result.current.showToast('Still here'); });
        act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS - 1); });
        expect(result.current.toast.message).toBe('Still here');
    });

    it('each new toast gets the full time, not the leftovers of the last', () => {
        const { result } = renderHook(() => useToast());
        act(() => { result.current.showToast('First'); });
        act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS - 100); });
        act(() => { result.current.showToast('Second'); });
        act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS - 100); });
        expect(result.current.toast.message).toBe('Second');
    });

    it('stops its timer on unmount', () => {
        const { result, unmount } = renderHook(() => useToast());
        act(() => { result.current.showToast('Saved'); });
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

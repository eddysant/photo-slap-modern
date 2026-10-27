// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSlidePosition } from '../src/hooks/useSlidePosition';

/**
 * The hook, not `resolvePosition`.
 *
 * The decision is pure and tested on its own; what is only testable here is
 * that a request survives from the caller that makes it to the derive that
 * consumes it, that consuming it clears it, and that an index left past the
 * end of a shrunken list heals itself. All three are effects or refs, and
 * all three are where "it jumped back to slide 1" came from.
 */

const file = (name: string): MediaFile => ({ name, path: `/lib/${name}`, type: 'image' });
const four = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(file);

const mount = (files: MediaFile[] = four) =>
    renderHook(({ f }: { f: MediaFile[] }) => useSlidePosition(f), { initialProps: { f: files } });

describe('useSlidePosition', () => {
    it('starts at the beginning', () => {
        expect(mount().result.current.index).toBe(0);
    });

    it('goes where it is told', () => {
        const { result } = mount();
        act(() => { result.current.goTo(2); });
        expect(result.current.index).toBe(2);
    });

    it('resolves a pinned path to its new position', () => {
        const { result } = mount();
        act(() => { result.current.pinPath('/lib/c.jpg'); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor([file('x.jpg'), file('c.jpg')]); });
        expect(resolved).toBe(1);
    });

    it('consumes the request, so the next derive starts fresh', () => {
        const { result } = mount();
        act(() => { result.current.pinPath('/lib/c.jpg'); });
        act(() => { result.current.resolveFor(four); });
        let again = -1;
        act(() => { again = result.current.resolveFor(four); });
        expect(again).toBe(0);
    });

    /** A new folder or a re-sort genuinely does mean "start at the top". */
    it('resolves to the first slide when nothing was requested', () => {
        const { result } = mount();
        act(() => { result.current.goTo(3); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four); });
        expect(resolved).toBe(0);
    });

    it('holds the slide now showing across a rebuild', () => {
        const { result } = mount();
        act(() => { result.current.goTo(2); });
        act(() => { result.current.hold(); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor([file('c.jpg'), file('d.jpg')]); });
        expect(resolved).toBe(0);   // c.jpg, wherever it ended up
    });

    it('follows the next survivor when the slide is deleted', () => {
        const { result } = mount();
        act(() => { result.current.goTo(1); });
        act(() => { result.current.pinSurvivorOf(['/lib/b.jpg']); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four.filter(f => f.name !== 'b.jpg')); });
        expect(resolved).toBe(1);   // c.jpg, where b.jpg was
    });

    /**
     * Slide 1 is the one answer that is always wrong here: a pin that cannot
     * be honoured means something unexpected happened to the list, and
     * throwing the viewer to the top is how every bug in this area showed up.
     */
    it('clamps to where the viewer was when the pinned file is gone too', () => {
        const { result } = mount();
        act(() => { result.current.goTo(2); });
        act(() => { result.current.pinPath('/lib/vanished.jpg'); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four); });
        expect(resolved).toBe(2);
    });

    it('clamps that fallback into a list that also shrank', () => {
        const { result } = mount();
        act(() => { result.current.goTo(3); });
        act(() => { result.current.pinPath('/lib/vanished.jpg'); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four.slice(0, 2)); });
        expect(resolved).toBe(1);
    });

    it('honours an index pin, for Resume', () => {
        const { result } = mount();
        act(() => { result.current.pinIndex(2); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four); });
        expect(resolved).toBe(2);
    });

    it('resolves to the first slide for an empty list', () => {
        const { result } = mount();
        act(() => { result.current.pinPath('/lib/c.jpg'); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor([]); });
        expect(resolved).toBe(0);
    });

    /**
     * `files[index]` coming back undefined killed the advance timer and threw
     * while rendering. Lists set outside the derive still have to be safe.
     */
    it('heals an index left past the end of a shrunken list', () => {
        const { result, rerender } = mount();
        act(() => { result.current.goTo(3); });
        rerender({ f: four.slice(0, 2) });
        expect(result.current.index).toBe(1);
    });

    it('applies a pin to a list set outside the derive', () => {
        const { result, rerender } = mount();
        act(() => { result.current.pinPath('/lib/d.jpg'); });
        rerender({ f: four.slice(1) });
        expect(result.current.index).toBe(2);
    });

    /**
     * The derive calls these back to back in one batch; the mirror the hook
     * keeps must already be current by then or the clamp above reads a stale
     * position.
     */
    it('sees the position it was just moved to', () => {
        const { result } = mount();
        act(() => { result.current.goTo(2); });
        act(() => { result.current.pinPath('/lib/vanished.jpg'); });
        let resolved = -1;
        act(() => { resolved = result.current.resolveFor(four); });
        expect(resolved).toBe(2);
    });
});

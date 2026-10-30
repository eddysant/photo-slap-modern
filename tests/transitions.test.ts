import { describe, it, expect } from 'vitest';
import {
    starPolygon, slideTransitions, resolveTransition, presenceModeFor, CONCRETE_TRANSITIONS,
    scaleSlideTransition, TRANSITION_SPEEDS, TRANSITION_SPEED_NAMES, type TransitionSpeed,
} from '../src/transitions';

const parsePoints = (polygon: string): [number, number][] => {
    const inner = polygon.slice('polygon('.length, -1);
    return inner.split(', ').map(pair => {
        const [x, y] = pair.split(' ').map(v => parseFloat(v));
        return [x, y];
    });
};

describe('starPolygon', () => {
    it('collapses to the center at scale 0', () => {
        for (const [x, y] of parsePoints(starPolygon(0))) {
            expect(x).toBe(50);
            expect(y).toBe(50);
        }
    });

    it('is a 10-point polygon (5-point star)', () => {
        expect(parsePoints(starPolygon(4))).toHaveLength(10);
    });

    it('covers the screen corners at scale 4', () => {
        // The closest boundary points of a star polygon are its concave inner
        // vertices (odd indices). They must sit farther from the center than
        // the screen corner (sqrt(50^2+50^2) ≈ 70.71 in percent space).
        const points = parsePoints(starPolygon(4));
        const cornerDist = Math.hypot(50, 50);
        const innerVertices = points.filter((_, i) => i % 2 === 1);
        for (const [x, y] of innerVertices) {
            expect(Math.hypot(x - 50, y - 50)).toBeGreaterThan(cornerDist);
        }
    });

    it('scales linearly around the center', () => {
        const p1 = parsePoints(starPolygon(1));
        const p2 = parsePoints(starPolygon(2));
        for (let i = 0; i < p1.length; i++) {
            expect(p2[i][0] - 50).toBeCloseTo(2 * (p1[i][0] - 50));
            expect(p2[i][1] - 50).toBeCloseTo(2 * (p1[i][1] - 50));
        }
    });
});

describe('slideTransitions.star', () => {
    const star = slideTransitions.star;

    it('does not fade the incoming slide (a fade degrades the wipe)', () => {
        expect(star.variants.enter).not.toHaveProperty('opacity');
        expect(star.variants.center).not.toHaveProperty('opacity');
    });

    it('keeps the outgoing slide visible for the wipe duration', () => {
        const exit = star.variants.exit as { transition?: { delay?: number } };
        const duration = (star.transition as { duration?: number }).duration ?? 0;
        expect(exit.transition?.delay ?? 0).toBeGreaterThanOrEqual(duration);
    });
});

describe('directional transitions', () => {
    type Dynamic = (dir: number) => Record<string, unknown>;

    it('slide mirrors when navigating backwards', () => {
        const enter = slideTransitions.slide.variants.enter as Dynamic;
        const exit = slideTransitions.slide.variants.exit as Dynamic;
        expect(enter(1).x).toBe('100%');
        expect(enter(-1).x).toBe('-100%');
        expect(exit(1).x).toBe('-100%');
        expect(exit(-1).x).toBe('100%');
    });

    it('flip mirrors when navigating backwards', () => {
        const enter = slideTransitions.flip.variants.enter as Dynamic;
        const exit = slideTransitions.flip.variants.exit as Dynamic;
        expect(enter(1).rotateY).toBe(90);
        expect(enter(-1).rotateY).toBe(-90);
        expect(exit(1).rotateY).toBe(-90);
        expect(exit(-1).rotateY).toBe(90);
    });

    it('zoom swaps in/out scales when navigating backwards', () => {
        const enter = slideTransitions.zoom.variants.enter as Dynamic;
        const exit = slideTransitions.zoom.variants.exit as Dynamic;
        expect(enter(1).scale).toBe(exit(-1).scale);
        expect(enter(-1).scale).toBe(exit(1).scale);
    });
});

describe('resolveTransition', () => {
    it('returns a fixed style unchanged', () => {
        for (const style of CONCRETE_TRANSITIONS) {
            expect(resolveTransition(style, null)).toBe(style);
            expect(resolveTransition(style, 'fade')).toBe(style);
        }
    });

    it('picks a concrete style for random', () => {
        expect(CONCRETE_TRANSITIONS).toContain(resolveTransition('random', null, () => 0.5));
    });

    it('never picks "random" itself', () => {
        for (let i = 0; i < 200; i++) {
            expect(resolveTransition('random', null)).not.toBe('random');
        }
    });

    it('never repeats the previous style back-to-back', () => {
        // A long slideshow landing on the same wipe twice in a row is exactly
        // the monotony this setting exists to break.
        let previous: ReturnType<typeof resolveTransition> | null = null;
        for (let i = 0; i < 500; i++) {
            const next = resolveTransition('random', previous);
            expect(next).not.toBe(previous);
            previous = next;
        }
    });

    it('can reach every concrete style', () => {
        const seen = new Set<string>();
        let previous: ReturnType<typeof resolveTransition> | null = null;
        for (let i = 0; i < 2000; i++) {
            previous = resolveTransition('random', previous);
            seen.add(previous);
        }
        expect([...seen].sort()).toEqual([...CONCRETE_TRANSITIONS].sort());
    });

    it('is driven by the injected random source', () => {
        expect(resolveTransition('random', null, () => 0)).toBe(CONCRETE_TRANSITIONS[0]);
    });
});

describe('presenceModeFor', () => {
    it('keeps both slides mounted only for the star wipe', () => {
        // sync is what lets the outgoing slide stay visible under the clip-path
        expect(presenceModeFor('star')).toBe('sync');
        for (const style of CONCRETE_TRANSITIONS.filter(s => s !== 'star')) {
            expect(presenceModeFor(style)).toBe('wait');
        }
    });

    it('has a defined mode for every concrete style', () => {
        for (const style of CONCRETE_TRANSITIONS) {
            expect(['sync', 'wait']).toContain(presenceModeFor(style));
        }
    });
});

describe('transition speed', () => {
    it('leaves the normal speed object untouched, by identity', () => {
        // The default must not hand framer-motion a fresh variants object on
        // every render just to multiply by one.
        for (const name of CONCRETE_TRANSITIONS) {
            expect(scaleSlideTransition(slideTransitions[name], 'normal'))
                .toBe(slideTransitions[name]);
        }
    });

    it('scales the top-level duration', () => {
        const fade = scaleSlideTransition(slideTransitions.fade, 'fast');
        expect(fade.transition.duration).toBeCloseTo(0.3 * TRANSITION_SPEEDS.fast);
    });

    it('gets faster with every step', () => {
        const durations = TRANSITION_SPEED_NAMES.map(
            speed => scaleSlideTransition(slideTransitions.slide, speed).transition.duration as number,
        );
        for (let i = 1; i < durations.length; i++) {
            expect(durations[i]).toBeLessThan(durations[i - 1]);
        }
    });

    it('scales a nested variant timing, not just the shared one', () => {
        const star = scaleSlideTransition(slideTransitions.star, 'faster');
        const exit = star.variants.exit as { transition: { duration: number; delay: number } };
        expect(exit.transition.delay).toBeCloseTo(0.65 * TRANSITION_SPEEDS.faster);
        expect(exit.transition.duration).toBeCloseTo(0.01 * TRANSITION_SPEEDS.faster);
    });

    /**
     * The invariant the star wipe depends on: the outgoing slide may only
     * hide itself once the growing clip-path has covered it. Scaling the wipe
     * without scaling that delay would uncover the slide underneath mid-wipe,
     * which is exactly the crossfade the star variant exists to avoid.
     */
    it('keeps the star wipe covered before the old slide disappears', () => {
        for (const speed of TRANSITION_SPEED_NAMES) {
            const star = scaleSlideTransition(slideTransitions.star, speed);
            const exit = star.variants.exit as { transition: { delay: number } };
            expect(exit.transition.delay, speed).toBeGreaterThanOrEqual(star.transition.duration as number);
        }
    });

    it('preserves easing and type while retiming', () => {
        const slide = scaleSlideTransition(slideTransitions.slide, 'instant');
        expect(slide.transition).toMatchObject({ type: 'tween', ease: 'easeInOut' });
        const crt = scaleSlideTransition(slideTransitions.crt, 'instant');
        expect(crt.transition.ease).toEqual(slideTransitions.crt.transition.ease);
    });

    it('passes a directional function variant through unchanged', () => {
        const slide = scaleSlideTransition(slideTransitions.slide, 'fast');
        expect(slide.variants.enter).toBe(slideTransitions.slide.variants.enter);
    });

    it('still produces a usable transition for an unknown speed', () => {
        const base = slideTransitions.fade;
        expect(scaleSlideTransition(base, 'nonsense' as TransitionSpeed)).toBe(base);
    });
});

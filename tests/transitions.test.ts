import { describe, it, expect } from 'vitest';
import { starPolygon, slideTransitions } from '../src/transitions';

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
    it('does not fade the incoming slide (a fade degrades the wipe)', () => {
        expect(slideTransitions.star.initial).not.toHaveProperty('opacity');
        expect(slideTransitions.star.animate).not.toHaveProperty('opacity');
    });

    it('keeps the outgoing slide visible for the wipe duration', () => {
        const exit = slideTransitions.star.exit as { transition?: { delay?: number } };
        const enter = slideTransitions.star.transition as { duration?: number };
        expect(exit.transition?.delay ?? 0).toBeGreaterThanOrEqual(enter.duration ?? 0);
    });
});

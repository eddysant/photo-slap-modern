import { describe, expect, it } from 'vitest';
import { dimHexColor } from '../src/hooks/useAmbientColor';

describe('dimHexColor', () => {
    it('dims each channel by the factor', () => {
        expect(dimHexColor('#ffffff', 0.5)).toBe('rgb(128, 128, 128)');
        expect(dimHexColor('#ff0000', 0.5)).toBe('rgb(128, 0, 0)');
    });

    it('keeps black black and handles the full range', () => {
        expect(dimHexColor('#000000', 0.5)).toBe('rgb(0, 0, 0)');
        expect(dimHexColor('#ffffff', 1)).toBe('rgb(255, 255, 255)');
        expect(dimHexColor('#ffffff', 0)).toBe('rgb(0, 0, 0)');
    });

    it('reads mixed-case hex', () => {
        expect(dimHexColor('#AaBbCc', 1)).toBe('rgb(170, 187, 204)');
    });

    it('rejects anything that is not #rrggbb', () => {
        // main returns null for undecodable files; the caller falls back to black
        for (const bad of [null, '', 'ffffff', '#fff', '#gggggg', '#ffffff00', 'rgb(1,2,3)']) {
            expect(dimHexColor(bad as string | null)).toBeNull();
        }
    });

    it('dims enough to read as a backdrop by default', () => {
        // A bright photo must not produce a background that competes with it
        const dimmed = dimHexColor('#ffffff');
        const value = Number(/rgb\((\d+)/.exec(dimmed ?? '')?.[1]);
        expect(value).toBeLessThan(128);
    });
});

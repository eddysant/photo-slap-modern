import { describe, expect, it } from 'vitest';
import { cullingActionForKey } from '../src/culling';
import { SETTINGS_PRESETS } from '../src/settingsPresets';
import { TRANSITION_SPEED_NAMES } from '../src/transitions';

describe('named settings presets', () => {
    it('provides the four named workflows with distinct intent', () => {
        expect(Object.keys(SETTINGS_PRESETS)).toEqual(['Photo Frame', 'Party', 'Culling', 'TV']);
        expect(SETTINGS_PRESETS['Photo Frame']).toMatchObject({ frameMode: true, autoPlayOnOpen: true, isKenBurns: true });
        expect(SETTINGS_PRESETS.Party).toMatchObject({ remoteEnabled: true, mediaFilter: 'both', isShuffle: true });
        expect(SETTINGS_PRESETS.Culling).toMatchObject({ cullingMode: true, mediaFilter: 'photos', autoPlayOnOpen: false });
        expect(SETTINGS_PRESETS.TV).toMatchObject({ controlsPosition: 'left', autoPlayOnOpen: true });
    });

    /**
     * A preset shapes the show, not the library. Starting or stopping sidecar
     * writes is a decision about the user's own folders, and picking "Party"
     * is not consent to either one.
     */
    it('does not decide where metadata is stored', () => {
        for (const preset of Object.values(SETTINGS_PRESETS)) {
            expect(Object.keys(preset)).not.toContain('metadataStorage');
        }
    });

    it('decides the backdrop for every preset rather than inheriting it', () => {
        // Applying a preset should fully determine the look; leaving the
        // ambient colour at whatever it happened to be would not.
        for (const preset of Object.values(SETTINGS_PRESETS)) {
            expect(typeof preset.isAmbientColor).toBe('boolean');
            // The blurred background fills the same space, so never both
            expect(preset.isSmart && preset.isAmbientColor).toBe(false);
        }
    });
});

describe('culling keyboard workflow', () => {
    it('maps keep and reject shortcuts without stealing unrelated keys', () => {
        expect(cullingActionForKey('k')).toBe('keep');
        expect(cullingActionForKey('Enter')).toBe('keep');
        expect(cullingActionForKey('X')).toBe('reject');
        expect(cullingActionForKey('ArrowRight')).toBeNull();
    });

    it('takes the key whichever way the shift key fell', () => {
        expect(cullingActionForKey('K')).toBe('keep');
        expect(cullingActionForKey('x')).toBe('reject');
    });

    /**
     * The review bar does not replace the rest of the keyboard: favorites,
     * tags and the quick-move slots stay live while culling, so claiming one
     * of their keys here would quietly break them.
     */
    it('leaves the shortcuts that still work during a review alone', () => {
        for (const key of ['h', 'H', 't', 'T', '1', '2', '3', ' ', 'g', 'p', 'Escape', 'Backspace']) {
            expect(cullingActionForKey(key)).toBeNull();
        }
    });
});


describe('presets decide how fast a transition runs', () => {
    it('names a speed for every preset rather than inheriting one', () => {
        for (const preset of Object.values(SETTINGS_PRESETS)) {
            expect(TRANSITION_SPEED_NAMES).toContain(preset.transitionSpeed);
        }
    });

    /**
     * Culling is a review bar, not a show: the wipe is the thing standing
     * between the reviewer and the next photo. Photo Frame is the opposite —
     * the transition is most of what there is to look at.
     */
    it('gets out of the way for culling and takes its time for a photo frame', () => {
        const order = TRANSITION_SPEED_NAMES;
        expect(order.indexOf(SETTINGS_PRESETS.Culling.transitionSpeed))
            .toBeGreaterThan(order.indexOf(SETTINGS_PRESETS['Photo Frame'].transitionSpeed));
    });
});

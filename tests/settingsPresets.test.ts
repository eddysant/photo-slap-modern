import { describe, expect, it } from 'vitest';
import { cullingActionForKey } from '../src/culling';
import { SETTINGS_PRESETS } from '../src/settingsPresets';

describe('named settings presets', () => {
    it('provides the four named workflows with distinct intent', () => {
        expect(Object.keys(SETTINGS_PRESETS)).toEqual(['Photo Frame', 'Party', 'Culling', 'TV']);
        expect(SETTINGS_PRESETS['Photo Frame']).toMatchObject({ frameMode: true, autoPlayOnOpen: true, isKenBurns: true });
        expect(SETTINGS_PRESETS.Party).toMatchObject({ remoteEnabled: true, mediaFilter: 'both', isShuffle: true });
        expect(SETTINGS_PRESETS.Culling).toMatchObject({ cullingMode: true, mediaFilter: 'photos', autoPlayOnOpen: false });
        expect(SETTINGS_PRESETS.TV).toMatchObject({ controlsPosition: 'left', autoPlayOnOpen: true });
    });
});

describe('culling keyboard workflow', () => {
    it('maps keep and reject shortcuts without stealing unrelated keys', () => {
        expect(cullingActionForKey('k')).toBe('keep');
        expect(cullingActionForKey('Enter')).toBe('keep');
        expect(cullingActionForKey('X')).toBe('reject');
        expect(cullingActionForKey('ArrowRight')).toBeNull();
    });
});


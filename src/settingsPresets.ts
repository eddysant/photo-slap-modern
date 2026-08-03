import type { ControlsPosition, MediaFilter, SortOrder } from './components/SettingsMenu';
import type { TransitionStyle } from './transitions';

export type SettingsPresetName = 'Photo Frame' | 'Party' | 'Culling' | 'TV';

export interface SettingsPreset {
    description: string;
    mediaFilter: MediaFilter;
    isShuffle: boolean;
    isSmart: boolean;
    isSmartVideoEnabled: boolean;
    isStretch: boolean;
    isKenBurns: boolean;
    isExifEnabled: boolean;
    transitionStyle: TransitionStyle;
    sortOrder: SortOrder;
    slideDuration: number;
    controlsPosition: ControlsPosition;
    showSlideTimer: boolean;
    frameMode: boolean;
    autoPlayOnOpen: boolean;
    remoteEnabled: boolean;
    cullingMode: boolean;
}

export const SETTINGS_PRESETS: Record<SettingsPresetName, SettingsPreset> = {
    'Photo Frame': {
        description: 'Ambient photos, slow motion, and an always-on frame overlay.',
        mediaFilter: 'photos', isShuffle: true, isSmart: true, isSmartVideoEnabled: false,
        isStretch: false, isKenBurns: true, isExifEnabled: false, transitionStyle: 'fade',
        sortOrder: 'name', slideDuration: 30000, controlsPosition: 'bottom',
        showSlideTimer: false, frameMode: true, autoPlayOnOpen: true,
        remoteEnabled: false, cullingMode: false,
    },
    Party: {
        description: 'Fast mixed-media shuffle with phone uploads and reactions.',
        mediaFilter: 'both', isShuffle: true, isSmart: true, isSmartVideoEnabled: true,
        isStretch: false, isKenBurns: false, isExifEnabled: false, transitionStyle: 'star',
        sortOrder: 'name', slideDuration: 5000, controlsPosition: 'bottom',
        showSlideTimer: true, frameMode: false, autoPlayOnOpen: true,
        remoteEnabled: true, cullingMode: false,
    },
    Culling: {
        description: 'Paused photo review with metadata and fast keep/reject controls.',
        mediaFilter: 'photos', isShuffle: false, isSmart: false, isSmartVideoEnabled: false,
        isStretch: false, isKenBurns: false, isExifEnabled: true, transitionStyle: 'fade',
        sortOrder: 'date-asc', slideDuration: 3000, controlsPosition: 'bottom',
        showSlideTimer: false, frameMode: false, autoPlayOnOpen: false,
        remoteEnabled: false, cullingMode: true,
    },
    TV: {
        description: 'Relaxed mixed-media playback tuned for a large display.',
        mediaFilter: 'both', isShuffle: true, isSmart: true, isSmartVideoEnabled: true,
        isStretch: false, isKenBurns: false, isExifEnabled: false, transitionStyle: 'fade',
        sortOrder: 'name', slideDuration: 10000, controlsPosition: 'left',
        showSlideTimer: false, frameMode: false, autoPlayOnOpen: true,
        remoteEnabled: false, cullingMode: false,
    },
};


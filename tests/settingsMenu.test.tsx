import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsMenu } from '../src/components/SettingsMenu';
import { TRANSITION_SPEED_LABELS, TRANSITION_SPEED_NAMES } from '../src/transitions';

const noop = () => {};

type Props = React.ComponentProps<typeof SettingsMenu>;

const render = (overrides: Partial<Props> = {}) => {
    const props: Props = {
        isOpen: true, onClose: noop, hasFiles: false, mediaFilter: 'both', onMediaFilterChange: noop,
        isShuffle: false, onToggleShuffle: noop, shuffleProgress: { viewed: 0, total: 0 }, onResetShuffle: noop,
        isSmart: false, onToggleSmart: noop, isAmbientColor: false, onToggleAmbientColor: noop,
        isSmartVideoEnabled: true, onToggleSmartVideo: noop, isStretch: false, onToggleStretch: noop,
        isKenBurns: false, onToggleKenBurns: noop, isExifEnabled: false, onToggleExif: noop,
        transitionStyle: 'fade', onTransitionChange: noop, sortOrder: 'name', onSortChange: noop,
        transitionSpeed: 'normal', onTransitionSpeedChange: noop,
        slideDuration: 3000, onDurationChange: noop, controlsPosition: 'bottom', onControlsPositionChange: noop,
        quickMoveFolders: [null, null, null], onSetQuickMoveFolder: noop, showSlideTimer: true, onToggleSlideTimer: noop,
        frameMode: false, onToggleFrameMode: noop, autoPlayOnOpen: false, onToggleAutoPlayOnOpen: noop,
        remoteEnabled: false, onToggleRemote: noop, remoteUrl: null, remoteQr: null,
        favoritesOnly: false, onToggleFavoritesOnly: noop, tagFilter: '', onTagFilterChange: noop, tagNames: [],
        cullingMode: false, onToggleCullingMode: noop,
        metadataStorage: 'sidecar', onMetadataStorageChange: noop,
        onApplyPreset: noop, onShowInFinder: noop, onFindDuplicates: noop, onScanHealth: noop,
    };
    return renderToStaticMarkup(<SettingsMenu {...props} {...overrides} />);
};

describe('options menu organization', () => {
    it('groups controls by workflow in a predictable order', () => {
        const html = render();
        const headings = ['Quick presets', 'Library &amp; order', 'Presentation', 'Playback &amp; display', 'Review workflow', 'Library tools'];
        let previous = -1;
        for (const heading of headings) {
            const index = html.indexOf(heading);
            expect(index).toBeGreaterThan(previous);
            previous = index;
        }
    });
});

describe('metadata storage control', () => {
    it('offers both places metadata can live', () => {
        const html = render();
        expect(html).toContain('Save tags &amp; favorites');
        expect(html).toContain('value="sidecar"');
        expect(html).toContain('value="memory"');
    });

    it('shows the mode that is actually in effect', () => {
        expect(render({ metadataStorage: 'memory' })).toContain('<option value="memory" selected="">');
        expect(render({ metadataStorage: 'sidecar' })).toContain('<option value="sidecar" selected="">');
    });

    /**
     * Session-only metadata is lost on quit. That is the whole trade and the
     * user has to be able to read it before choosing, not discover it after.
     */
    it('says plainly that session-only changes do not survive a quit', () => {
        expect(render()).toMatch(/gone when you quit/);
    });

    it('names the file it would otherwise write', () => {
        expect(render()).toContain('.photo-slap.json');
    });
});

describe('transition speed control', () => {
    it('offers every speed, labelled, next to the transition itself', () => {
        const html = render();
        expect(html).toContain('Transition speed');
        for (const speed of TRANSITION_SPEED_NAMES) {
            expect(html).toContain(`value="${speed}"`);
            expect(html).toContain(TRANSITION_SPEED_LABELS[speed]);
        }
        // It is a presentation choice, so it belongs with Transition rather
        // than off in another section.
        expect(html.indexOf('Transition speed')).toBeGreaterThan(html.indexOf('Playback &amp; display'));
    });

    it('shows the speed currently in force', () => {
        const html = render({ transitionSpeed: 'faster' });
        expect(html).toMatch(/<option[^>]*value="faster"[^>]*selected/);
    });
});

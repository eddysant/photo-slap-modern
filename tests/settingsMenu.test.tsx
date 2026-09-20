import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsMenu } from '../src/components/SettingsMenu';

describe('options menu organization', () => {
    it('groups controls by workflow in a predictable order', () => {
        const noop = () => {};
        const html = renderToStaticMarkup(<SettingsMenu
            isOpen onClose={noop} hasFiles={false} mediaFilter="both" onMediaFilterChange={noop}
            isShuffle={false} onToggleShuffle={noop} shuffleProgress={{ viewed: 0, total: 0 }} onResetShuffle={noop} isSmart={false} onToggleSmart={noop} isAmbientColor={false} onToggleAmbientColor={noop}
            isSmartVideoEnabled={true} onToggleSmartVideo={noop} isStretch={false} onToggleStretch={noop}
            isKenBurns={false} onToggleKenBurns={noop} isExifEnabled={false} onToggleExif={noop}
            transitionStyle="fade" onTransitionChange={noop} sortOrder="name" onSortChange={noop}
            slideDuration={3000} onDurationChange={noop} controlsPosition="bottom" onControlsPositionChange={noop}
            quickMoveFolders={[null, null, null]} onSetQuickMoveFolder={noop} showSlideTimer={true} onToggleSlideTimer={noop}
            frameMode={false} onToggleFrameMode={noop} autoPlayOnOpen={false} onToggleAutoPlayOnOpen={noop}
            remoteEnabled={false} onToggleRemote={noop} remoteUrl={null} remoteQr={null}
            favoritesOnly={false} onToggleFavoritesOnly={noop} tagFilter="" onTagFilterChange={noop} tagNames={[]}
            cullingMode={false} onToggleCullingMode={noop} onApplyPreset={noop}
            onShowInFinder={noop} onFindDuplicates={noop} onScanHealth={noop}
        />);
        const headings = ['Quick presets', 'Library &amp; order', 'Presentation', 'Playback &amp; display', 'Review workflow', 'Library tools'];
        let previous = -1;
        for (const heading of headings) {
            const index = html.indexOf(heading);
            expect(index).toBeGreaterThan(previous);
            previous = index;
        }
    });
});

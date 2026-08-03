import { AnimatePresence, motion } from 'framer-motion';
import { FiActivity, FiFolder, FiLayers, FiX } from 'react-icons/fi';
import { SETTINGS_PRESETS, type SettingsPresetName } from '../settingsPresets';
import type { TransitionStyle } from '../transitions';

export type MediaFilter = 'both' | 'photos' | 'videos';
export type ControlsPosition = 'bottom' | 'left';
export type SortOrder = 'name' | 'date-desc' | 'date-asc';

interface SettingsMenuProps {
    isOpen: boolean;
    onClose: () => void;
    hasFiles: boolean;
    mediaFilter: MediaFilter;
    onMediaFilterChange: (filter: MediaFilter) => void;
    isShuffle: boolean;
    onToggleShuffle: () => void;
    isSmart: boolean;
    onToggleSmart: () => void;
    isSmartVideoEnabled: boolean;
    onToggleSmartVideo: () => void;
    isStretch: boolean;
    onToggleStretch: () => void;
    isKenBurns: boolean;
    onToggleKenBurns: () => void;
    isExifEnabled: boolean;
    onToggleExif: () => void;
    transitionStyle: TransitionStyle;
    onTransitionChange: (style: TransitionStyle) => void;
    sortOrder: SortOrder;
    onSortChange: (order: SortOrder) => void;
    slideDuration: number;
    onDurationChange: (duration: number) => void;
    controlsPosition: ControlsPosition;
    onControlsPositionChange: (position: ControlsPosition) => void;
    quickMoveFolders: (string | null)[];
    onSetQuickMoveFolder: (slot: number, path: string | null) => void;
    showSlideTimer: boolean;
    onToggleSlideTimer: () => void;
    frameMode: boolean;
    onToggleFrameMode: () => void;
    autoPlayOnOpen: boolean;
    onToggleAutoPlayOnOpen: () => void;
    remoteEnabled: boolean;
    onToggleRemote: () => void;
    remoteUrl: string | null;
    remoteQr: string | null;
    favoritesOnly: boolean;
    onToggleFavoritesOnly: () => void;
    tagFilter: string;
    onTagFilterChange: (tag: string) => void;
    tagNames: string[];
    cullingMode: boolean;
    onToggleCullingMode: () => void;
    onApplyPreset: (name: SettingsPresetName) => void;
    onShowInFinder: () => void;
    onFindDuplicates: () => void;
    onScanHealth: () => void;
}

const Toggle = ({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) => (
    <label className="checkbox-control">
        <input type="checkbox" checked={checked} onChange={onChange} />
        <span>{children}</span>
    </label>
);

export function SettingsMenu(props: SettingsMenuProps) {
    return (
        <AnimatePresence>
            {props.isOpen && (
                <motion.aside
                    className="settings-menu"
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '100%' }}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    aria-label="Options"
                >
                    <div className="settings-header">
                        <div><span>Options</span><small>Shape the current experience</small></div>
                        <button className="control-btn" onClick={props.onClose} aria-label="Close options"><FiX size={22} /></button>
                    </div>

                    <section className="settings-section preset-section">
                        <div className="settings-section-title">Quick presets</div>
                        <div className="preset-grid">
                            {(Object.keys(SETTINGS_PRESETS) as SettingsPresetName[]).map(name => (
                                <button key={name} className="preset-card" onClick={() => props.onApplyPreset(name)}>
                                    <strong>{name}</strong>
                                    <span>{SETTINGS_PRESETS[name].description}</span>
                                </button>
                            ))}
                        </div>
                    </section>

                    <section className="settings-section">
                        <div className="settings-section-title">Library & order</div>
                        <div className="settings-grid">
                            <label className="setting-item"><span className="setting-label">Media</span>
                                <select className="setting-control" value={props.mediaFilter} onChange={e => props.onMediaFilterChange(e.target.value as MediaFilter)}>
                                    <option value="both">Photos & Videos</option><option value="photos">Photos Only</option><option value="videos">Videos Only</option>
                                </select>
                            </label>
                            <label className="setting-item"><span className="setting-label">Sort</span>
                                <select className="setting-control" value={props.sortOrder} onChange={e => props.onSortChange(e.target.value as SortOrder)}>
                                    <option value="name">Name</option><option value="date-desc">Newest First</option><option value="date-asc">Oldest First</option>
                                </select>
                            </label>
                        </div>
                        <div className="toggle-grid">
                            <Toggle checked={props.isShuffle} onChange={props.onToggleShuffle}>No-repeat shuffle</Toggle>
                            <Toggle checked={props.favoritesOnly} onChange={props.onToggleFavoritesOnly}>Favorites only</Toggle>
                        </div>
                        {props.tagNames.length > 0 && (
                            <label className="setting-item"><span className="setting-label">Tag filter</span>
                                <select className="setting-control" value={props.tagFilter} onChange={e => props.onTagFilterChange(e.target.value)}>
                                    <option value="">All Tags</option>{props.tagNames.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                                </select>
                            </label>
                        )}
                    </section>

                    <section className="settings-section">
                        <div className="settings-section-title">Presentation</div>
                        <div className="toggle-grid">
                            <Toggle checked={props.isSmart} onChange={props.onToggleSmart}>Smart background</Toggle>
                            <Toggle checked={props.isStretch} onChange={props.onToggleStretch}>Fit edge to edge</Toggle>
                            <Toggle checked={props.isKenBurns} onChange={props.onToggleKenBurns}>Ken Burns motion</Toggle>
                            <Toggle checked={props.isExifEnabled} onChange={props.onToggleExif}>EXIF details</Toggle>
                            <Toggle checked={props.showSlideTimer} onChange={props.onToggleSlideTimer}>Timer bar</Toggle>
                            <Toggle checked={props.frameMode} onChange={props.onToggleFrameMode}>Photo frame overlay</Toggle>
                        </div>
                        {props.isSmart && <div className="nested-setting"><Toggle checked={props.isSmartVideoEnabled} onChange={props.onToggleSmartVideo}>Also blur video backgrounds</Toggle></div>}
                    </section>

                    <section className="settings-section">
                        <div className="settings-section-title">Playback & display</div>
                        <div className="settings-grid">
                            <label className="setting-item"><span className="setting-label">Transition</span>
                                <select className="setting-control" value={props.transitionStyle} onChange={e => props.onTransitionChange(e.target.value as TransitionStyle)}>
                                    <option value="fade">Fade</option><option value="slide">Slide</option><option value="zoom">Zoom</option><option value="flip">Flip</option><option value="star">Star Wipe</option>
                                </select>
                            </label>
                            <label className="setting-item"><span className="setting-label">Photo duration</span>
                                <select className="setting-control" value={props.slideDuration} onChange={e => props.onDurationChange(parseInt(e.target.value))}>
                                    <option value={2000}>2 Seconds</option><option value={3000}>3 Seconds</option><option value={5000}>5 Seconds</option><option value={10000}>10 Seconds</option><option value={30000}>30 Seconds</option><option value={60000}>1 Minute</option>
                                </select>
                            </label>
                            <label className="setting-item"><span className="setting-label">Controls</span>
                                <select className="setting-control" value={props.controlsPosition} onChange={e => props.onControlsPositionChange(e.target.value as ControlsPosition)}>
                                    <option value="bottom">Bottom Center</option><option value="left">Left Side</option>
                                </select>
                            </label>
                        </div>
                        <div className="toggle-grid">
                            <Toggle checked={props.autoPlayOnOpen} onChange={props.onToggleAutoPlayOnOpen}>Auto-play on open</Toggle>
                            <Toggle checked={props.remoteEnabled} onChange={props.onToggleRemote}>Phone remote (LAN)</Toggle>
                        </div>
                        {props.remoteEnabled && props.remoteUrl && (
                            <div className="remote-info">
                                {props.remoteQr && <img className="remote-qr" src={props.remoteQr} alt="Remote control QR code" />}
                                <div><div className="remote-url" title={props.remoteUrl}>{props.remoteUrl}</div><small>Same Wi-Fi network</small></div>
                            </div>
                        )}
                    </section>

                    <section className="settings-section">
                        <div className="settings-section-title">Review workflow</div>
                        <Toggle checked={props.cullingMode} onChange={props.onToggleCullingMode}>Photo culling mode</Toggle>
                        <p className="settings-help">Culling pauses playback and shows Keep (K/Enter), Favorite (H), Reject (X), and quick-move controls.</p>
                        <div className="setting-item">
                            <span className="setting-label">Quick-move folders · keys 1–3</span>
                            {props.quickMoveFolders.map((folder, i) => (
                                <div key={i} className="quick-move-row">
                                    <span className="quick-move-key">{i + 1}</span>
                                    <span className="quick-move-path" title={folder ?? ''}>{folder ? folder.split(/[/\\]/).pop() : 'Not set'}</span>
                                    <button className="text-btn" onClick={async () => { const dir = await window.api.pickDirectory(); if (dir) props.onSetQuickMoveFolder(i, dir); }}>Set</button>
                                    {folder && <button className="text-btn" onClick={() => props.onSetQuickMoveFolder(i, null)}>Clear</button>}
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="settings-section settings-tools">
                        <div className="settings-section-title">Library tools</div>
                        <div className="tool-grid">
                            {props.hasFiles && <button className="retro-button compact" onClick={props.onShowInFinder}><FiFolder /> Show in Finder</button>}
                            <button className="retro-button compact" onClick={props.onFindDuplicates}><FiLayers /> Find Duplicates</button>
                            <button className="retro-button compact" onClick={props.onScanHealth}><FiActivity /> Library Health</button>
                        </div>
                    </section>
                </motion.aside>
            )}
        </AnimatePresence>
    );
}

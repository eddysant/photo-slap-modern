import { AnimatePresence, motion } from 'framer-motion';
import { FiFolder, FiLayers } from 'react-icons/fi';
import type { TransitionStyle } from '../transitions';

export type MediaFilter = 'both' | 'photos' | 'videos';
export type ControlsPosition = 'bottom' | 'left';
export type SortOrder = 'name' | 'date-desc' | 'date-asc';

interface SettingsMenuProps {
    isOpen: boolean;
    onClose: () => void;
    /** False on the intro screen — file-specific actions are hidden. */
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
    /** Target folders for the 1/2/3 quick-move shortcuts (null = unset). */
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
    onShowInFinder: () => void;
    onFindDuplicates: () => void;
}

export function SettingsMenu(props: SettingsMenuProps) {
    return (
        <AnimatePresence>
            {props.isOpen && (
                <motion.div
                    className="settings-menu"
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '100%' }}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                >
                    <div className="settings-header">Options</div>

                    <div className="setting-item">
                        <div className="setting-label">Media Filter</div>
                        <select
                            className="setting-control"
                            value={props.mediaFilter}
                            onChange={e => props.onMediaFilterChange(e.target.value as MediaFilter)}
                        >
                            <option value="both">Both</option>
                            <option value="photos">Photos Only</option>
                            <option value="videos">Videos Only</option>
                        </select>
                    </div>

                    <div className="setting-item">
                        <div className="setting-label">Sort By</div>
                        <select
                            className="setting-control"
                            value={props.sortOrder}
                            onChange={e => props.onSortChange(e.target.value as SortOrder)}
                        >
                            <option value="name">Name</option>
                            <option value="date-desc">Date (Newest First)</option>
                            <option value="date-asc">Date (Oldest First)</option>
                        </select>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.isShuffle} onChange={props.onToggleShuffle} />
                            Shuffle Photos
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.favoritesOnly} onChange={props.onToggleFavoritesOnly} />
                            Favorites Only
                        </label>
                    </div>

                    {props.tagNames.length > 0 && (
                        <div className="setting-item">
                            <div className="setting-label">Filter By Tag</div>
                            <select
                                className="setting-control"
                                value={props.tagFilter}
                                onChange={e => props.onTagFilterChange(e.target.value)}
                            >
                                <option value="">All Tags</option>
                                {props.tagNames.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                            </select>
                        </div>
                    )}

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.isSmart} onChange={props.onToggleSmart} />
                            Smart Background
                        </label>
                    </div>

                    {props.isSmart && (
                        <div className="setting-item" style={{ paddingLeft: '24px', marginTop: '-4px' }}>
                            <label className="checkbox-control">
                                <input type="checkbox" checked={props.isSmartVideoEnabled} onChange={props.onToggleSmartVideo} />
                                Smart Background (Videos)
                            </label>
                        </div>
                    )}

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.isStretch} onChange={props.onToggleStretch} />
                            Force Stretch
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.isKenBurns} onChange={props.onToggleKenBurns} />
                            Ken Burns Effect
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.isExifEnabled} onChange={props.onToggleExif} />
                            Show EXIF Data
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.showSlideTimer} onChange={props.onToggleSlideTimer} />
                            Slide Timer Bar
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.frameMode} onChange={props.onToggleFrameMode} />
                            Photo Frame Overlay
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.autoPlayOnOpen} onChange={props.onToggleAutoPlayOnOpen} />
                            Auto-Play On Open
                        </label>
                    </div>

                    <div className="setting-item">
                        <label className="checkbox-control">
                            <input type="checkbox" checked={props.remoteEnabled} onChange={props.onToggleRemote} />
                            Phone Remote (LAN)
                        </label>
                        {props.remoteEnabled && props.remoteUrl && (
                            <div className="remote-info">
                                {props.remoteQr && <img className="remote-qr" src={props.remoteQr} alt="Remote control QR code" />}
                                <div className="remote-url" title={props.remoteUrl}>{props.remoteUrl}</div>
                                <small>Scan with your phone (same Wi-Fi network)</small>
                            </div>
                        )}
                    </div>

                    <div className="setting-item">
                        <div className="setting-label">Slide Transition</div>
                        <select
                            className="setting-control"
                            value={props.transitionStyle}
                            onChange={e => props.onTransitionChange(e.target.value as TransitionStyle)}
                        >
                            <option value="fade">Fade</option>
                            <option value="slide">Slide</option>
                            <option value="zoom">Zoom</option>
                            <option value="flip">Flip</option>
                            <option value="star">Star Wipe</option>
                        </select>
                    </div>

                    <div className="setting-item">
                        <div className="setting-label">Slide Duration</div>
                        <select
                            className="setting-control"
                            value={props.slideDuration}
                            onChange={e => props.onDurationChange(parseInt(e.target.value))}
                        >
                            <option value={2000}>2 Seconds</option>
                            <option value={3000}>3 Seconds</option>
                            <option value={5000}>5 Seconds</option>
                            <option value={10000}>10 Seconds</option>
                            <option value={30000}>30 Seconds</option>
                            <option value={60000}>1 Minute</option>
                        </select>
                    </div>

                    <div className="setting-item">
                        <div className="setting-label">Controls Position</div>
                        <select
                            className="setting-control"
                            value={props.controlsPosition}
                            onChange={e => props.onControlsPositionChange(e.target.value as ControlsPosition)}
                        >
                            <option value="bottom">Bottom Center</option>
                            <option value="left">Left Side</option>
                        </select>
                    </div>

                    <div className="setting-item">
                        <div className="setting-label">Quick-Move Folders (Keys 1–3)</div>
                        {props.quickMoveFolders.map((folder, i) => (
                            <div key={i} className="quick-move-row">
                                <span className="quick-move-key">{i + 1}</span>
                                <span className="quick-move-path" title={folder ?? ''}>
                                    {folder ? folder.split(/[/\\]/).pop() : '—'}
                                </span>
                                <button
                                    className="text-btn"
                                    onClick={async () => {
                                        const dir = await window.api.pickDirectory();
                                        if (dir) props.onSetQuickMoveFolder(i, dir);
                                    }}
                                >
                                    Set
                                </button>
                                {folder && (
                                    <button className="text-btn" onClick={() => props.onSetQuickMoveFolder(i, null)}>
                                        Clear
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>

                    {props.hasFiles && (
                        <div className="setting-item">
                            <button
                                className="retro-button"
                                style={{ width: '100%', fontSize: '14px', padding: '10px' }}
                                onClick={props.onShowInFinder}
                            >
                                <FiFolder style={{ marginRight: 8 }} /> SHOW IN FINDER
                            </button>
                        </div>
                    )}

                    <div className="setting-item">
                        <button
                            className="retro-button"
                            style={{ width: '100%', fontSize: '14px', padding: '10px' }}
                            onClick={props.onFindDuplicates}
                        >
                            <FiLayers style={{ marginRight: 8 }} /> FIND DUPLICATES
                        </button>
                    </div>

                    <div style={{ marginTop: 'auto' }}>
                        <button
                            className="primary-button"
                            style={{ width: '100%', justifyContent: 'center', fontFamily: 'Silkscreen' }}
                            onClick={props.onClose}
                        >
                            Close
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

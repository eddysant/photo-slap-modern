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

                    {props.hasFiles && (
                        <div className="setting-item">
                            <button
                                className="balatro-button"
                                style={{ width: '100%', fontSize: '14px', padding: '10px' }}
                                onClick={props.onShowInFinder}
                            >
                                <FiFolder style={{ marginRight: 8 }} /> SHOW IN FINDER
                            </button>
                        </div>
                    )}

                    <div className="setting-item">
                        <button
                            className="balatro-button"
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

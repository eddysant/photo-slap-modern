import { FiActivity, FiSettings, FiLayers } from 'react-icons/fi';

interface IntroScreenProps {
    isLoading: boolean;
    onOpenDirectory: () => void;
    /** Name of the most recently opened folder, if any. */
    lastDirName?: string | null;
    onResume?: () => void;
    onOpenSettings: () => void;
    onFindDuplicates: () => void;
    onScanHealth: () => void;
}

export function IntroScreen({ isLoading, onOpenDirectory, lastDirName, onResume, onOpenSettings, onFindDuplicates, onScanHealth }: IntroScreenProps) {
    return (
        <div className="intro-container">
            <div className="crt-overlay" />

            <button className="control-btn intro-settings-btn" onClick={onOpenSettings} title="Settings">
                <FiSettings size={22} />
            </button>

            <div className="intro-title">
                PHOTO<br />SLAP
            </div>

            <div className="intro-actions">
                <button className="retro-button intro-action-button" onClick={onOpenDirectory} disabled={isLoading}>
                    {isLoading ? 'SCANNING...' : 'OPEN FOLDER'}
                </button>

                {lastDirName && (
                    <button className="retro-button intro-action-button" onClick={onResume} disabled={isLoading} title={`Resume ${lastDirName}`}>
                        RESUME LIBRARY
                    </button>
                )}

                <button className="retro-button intro-action-button" onClick={onFindDuplicates} disabled={isLoading}>
                    <FiLayers /> FIND DUPLICATES
                </button>

                <button className="retro-button intro-action-button" onClick={onScanHealth} disabled={isLoading}>
                    <FiActivity /> LIBRARY HEALTH
                </button>
            </div>

            <div className="intro-hint">or drop a folder anywhere</div>
        </div>
    );
}

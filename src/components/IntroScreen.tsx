import { FiSettings, FiLayers } from 'react-icons/fi';

interface IntroScreenProps {
    isLoading: boolean;
    onOpenDirectory: () => void;
    /** Name of the most recently opened folder, if any. */
    lastDirName?: string | null;
    onResume?: () => void;
    onOpenSettings: () => void;
    onFindDuplicates: () => void;
}

export function IntroScreen({ isLoading, onOpenDirectory, lastDirName, onResume, onOpenSettings, onFindDuplicates }: IntroScreenProps) {
    return (
        <div className="intro-container">
            <div className="crt-overlay" />

            <button className="control-btn intro-settings-btn" onClick={onOpenSettings} title="Settings">
                <FiSettings size={22} />
            </button>

            <div className="intro-title">
                PHOTO<br />SLAP
            </div>

            <button className="retro-button" onClick={onOpenDirectory} disabled={isLoading}>
                {isLoading ? 'SCANNING...' : 'OPEN FOLDER'}
            </button>

            {lastDirName && (
                <button className="retro-button resume-button" onClick={onResume} disabled={isLoading}>
                    RESUME "{lastDirName}"
                </button>
            )}

            <button className="retro-button resume-button" onClick={onFindDuplicates} disabled={isLoading}>
                <FiLayers style={{ marginRight: 8 }} /> FIND DUPLICATES
            </button>

            <div className="intro-hint">or drop a folder anywhere</div>
        </div>
    );
}

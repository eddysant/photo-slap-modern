interface IntroScreenProps {
    isLoading: boolean;
    onOpenDirectory: () => void;
    /** Name of the most recently opened folder, if any. */
    lastDirName?: string | null;
    onResume?: () => void;
}

export function IntroScreen({ isLoading, onOpenDirectory, lastDirName, onResume }: IntroScreenProps) {
    return (
        <div className="balatro-container">
            <div className="crt-overlay" />

            <div className="balatro-title">
                PHOTO<br />SLAP
            </div>

            <button className="balatro-button" onClick={onOpenDirectory} disabled={isLoading}>
                {isLoading ? 'SCANNING...' : 'OPEN FOLDER'}
            </button>

            {lastDirName && (
                <button className="balatro-button resume-button" onClick={onResume} disabled={isLoading}>
                    RESUME "{lastDirName}"
                </button>
            )}

            <div className="intro-hint">or drop a folder anywhere</div>
        </div>
    );
}

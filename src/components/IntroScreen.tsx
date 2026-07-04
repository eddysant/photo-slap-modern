interface IntroScreenProps {
    isLoading: boolean;
    onOpenDirectory: () => void;
}

export function IntroScreen({ isLoading, onOpenDirectory }: IntroScreenProps) {
    return (
        <div className="balatro-container">
            <div className="crt-overlay" />

            <div className="balatro-title">
                PHOTO<br />SLAP
            </div>

            <button className="balatro-button" onClick={onOpenDirectory} disabled={isLoading}>
                {isLoading ? 'SCANNING...' : 'OPEN FOLDER'}
            </button>
        </div>
    );
}

import { useEffect, useRef } from 'react';
import { FiFilm } from 'react-icons/fi';
import { getFileUrl } from '../utils';

interface GridViewProps {
    files: MediaFile[];
    currentIndex: number;
    onSelect: (index: number) => void;
    onClose: () => void;
}

/**
 * Thumbnail grid for jumping around a folder. Images lazy-load (only the
 * cells scrolled into view are fetched); videos get a placeholder tile.
 */
export function GridView({ files, currentIndex, onSelect, onClose }: GridViewProps) {
    const activeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'center' });
    }, []);

    return (
        <div className="grid-overlay" onClick={onClose}>
            <div className="grid-container" onClick={e => e.stopPropagation()}>
                {files.map((file, i) => (
                    <button
                        key={file.path}
                        ref={i === currentIndex ? activeRef : undefined}
                        className={`grid-cell ${i === currentIndex ? 'active' : ''}`}
                        title={file.name}
                        onClick={() => onSelect(i)}
                    >
                        {file.type === 'image' ? (
                            <img src={getFileUrl(file.path)} loading="lazy" decoding="async" alt={file.name} />
                        ) : (
                            <div className="grid-video-tile">
                                <FiFilm size={28} />
                                <span>{file.name}</span>
                            </div>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}

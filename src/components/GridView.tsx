import { useEffect, useRef, useState } from 'react';
import { FiFilm, FiHeart, FiSearch } from 'react-icons/fi';
import { getFileUrl } from '../utils';

interface GridViewProps {
    files: MediaFile[];
    currentIndex: number;
    favorites: Set<string>;
    onSelect: (index: number) => void;
    onClose: () => void;
}

/**
 * Thumbnail grid for jumping around a folder, with a filename filter.
 * Images lazy-load (only the cells scrolled into view are fetched);
 * videos get a placeholder tile.
 */
export function GridView({ files, currentIndex, favorites, onSelect, onClose }: GridViewProps) {
    const activeRef = useRef<HTMLButtonElement>(null);
    const [filter, setFilter] = useState('');

    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'center' });
    }, []);

    const query = filter.trim().toLowerCase();
    const visible = files
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => !query || file.name.toLowerCase().includes(query));

    return (
        <div className="grid-overlay" onClick={onClose}>
            <div className="grid-toolbar" onClick={e => e.stopPropagation()}>
                <FiSearch size={16} />
                <input
                    className="grid-filter"
                    placeholder="Filter by filename…"
                    value={filter}
                    autoFocus
                    onChange={e => setFilter(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') {
                            e.stopPropagation();
                            if (filter) setFilter('');
                            else onClose();
                        }
                    }}
                />
                <span className="grid-count">{visible.length} / {files.length}</span>
            </div>

            <div className="grid-container" onClick={e => e.stopPropagation()}>
                {visible.map(({ file, index }) => (
                    <button
                        key={file.path}
                        ref={index === currentIndex ? activeRef : undefined}
                        className={`grid-cell ${index === currentIndex ? 'active' : ''}`}
                        title={file.name}
                        onClick={() => onSelect(index)}
                    >
                        {file.type === 'image' ? (
                            <img src={getFileUrl(file.path)} loading="lazy" decoding="async" alt={file.name} />
                        ) : (
                            <div className="grid-video-tile">
                                <FiFilm size={28} />
                                <span>{file.name}</span>
                            </div>
                        )}
                        {favorites.has(file.path) && <FiHeart className="grid-heart" />}
                    </button>
                ))}
            </div>
        </div>
    );
}

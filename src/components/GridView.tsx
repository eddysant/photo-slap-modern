import { useEffect, useMemo, useRef, useState } from 'react';
import { FiFilm, FiHeart, FiSearch, FiCheckSquare, FiTrash2, FiX } from 'react-icons/fi';
import { getDisplayUrl } from '../utils';

interface GridViewProps {
    files: MediaFile[];
    currentIndex: number;
    favorites: Set<string>;
    fileTags: Record<string, string[]>;
    tagNames: string[];
    quickMoveFolders: (string | null)[];
    onSelect: (index: number) => void;
    onClose: () => void;
    onBatchFavorite: (paths: string[], favorite: boolean) => void;
    onBatchTag: (paths: string[], tag: string) => void;
    onBatchDelete: (paths: string[]) => void;
    onBatchMove: (paths: string[], slot: number) => void;
}

const CELL_MIN = 150;
const GAP = 8;
const OVERLAY_PAD_X = 16;
const TOOLBAR_ALLOWANCE = 60;

/**
 * Thumbnail grid with filename/favorite/tag filters and a select mode for
 * batch operations. Rendering is windowed (spacer rows above/below the
 * visible slice) so folders with tens of thousands of photos stay smooth.
 */
export function GridView({
    files, currentIndex, favorites, fileTags, tagNames, quickMoveFolders,
    onSelect, onClose, onBatchFavorite, onBatchTag, onBatchDelete, onBatchMove,
}: GridViewProps) {
    const [filter, setFilter] = useState('');
    const [favsOnly, setFavsOnly] = useState(false);
    const [tagFilter, setTagFilter] = useState('');
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [batchTag, setBatchTag] = useState('');

    const overlayRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const el = overlayRef.current;
        if (!el) return;
        const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const query = filter.trim().toLowerCase();
    const visible = useMemo(() =>
        files
            .map((file, index) => ({ file, index }))
            .filter(({ file }) => {
                if (query && !file.name.toLowerCase().includes(query)) return false;
                if (favsOnly && !favorites.has(file.path)) return false;
                if (tagFilter && !fileTags[file.path]?.includes(tagFilter)) return false;
                return true;
            }),
        [files, query, favsOnly, tagFilter, favorites, fileTags]);

    // ---- windowed layout ----
    const innerWidth = Math.max(0, viewport.width - OVERLAY_PAD_X * 2);
    const cols = Math.max(2, Math.floor((innerWidth + GAP) / (CELL_MIN + GAP)));
    const cellSize = cols > 0 ? (innerWidth - (cols - 1) * GAP) / cols : CELL_MIN;
    const rowHeight = cellSize + GAP;
    const totalRows = Math.ceil(visible.length / cols);
    const firstRow = Math.max(0, Math.floor((scrollTop - TOOLBAR_ALLOWANCE) / rowHeight) - 2);
    const lastRow = Math.min(totalRows, Math.ceil((scrollTop + viewport.height) / rowHeight) + 2);
    const slice = visible.slice(firstRow * cols, lastRow * cols);
    const topSpace = firstRow * rowHeight;
    const bottomSpace = Math.max(0, (totalRows - lastRow) * rowHeight);

    // Scroll the current slide into view once the viewport is measured
    const didInitialScroll = useRef(false);
    useEffect(() => {
        if (didInitialScroll.current || viewport.width === 0 || !overlayRef.current) return;
        didInitialScroll.current = true;
        const pos = visible.findIndex(v => v.index === currentIndex);
        if (pos > 0) {
            overlayRef.current.scrollTop = Math.max(0, Math.floor(pos / cols) * rowHeight - viewport.height / 2);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewport.width]);

    const toggleSelected = (path: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const selectedPaths = () => [...selected];
    const clearSelection = () => setSelected(new Set());

    const applyBatchTag = () => {
        const tag = batchTag.trim();
        if (tag && selected.size > 0) {
            onBatchTag(selectedPaths(), tag);
            setBatchTag('');
        }
    };

    return (
        <div className="grid-overlay" ref={overlayRef} onClick={onClose}
            onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
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
                <button
                    className={`grid-chip ${favsOnly ? 'on' : ''}`}
                    onClick={() => setFavsOnly(v => !v)}
                    title="Favorites only"
                >
                    <FiHeart size={12} /> Favs
                </button>
                {tagNames.length > 0 && (
                    <select className="grid-tag-select" value={tagFilter} onChange={e => setTagFilter(e.target.value)}>
                        <option value="">All tags</option>
                        {tagNames.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                    </select>
                )}
                <button
                    className={`grid-chip grid-select-toggle ${selectMode ? 'on' : ''}`}
                    onClick={() => { setSelectMode(v => !v); clearSelection(); }}
                    title="Select multiple files"
                >
                    <FiCheckSquare size={12} /> Select
                </button>
                <span className="grid-count">{visible.length} / {files.length}</span>
            </div>

            {selectMode && (
                <div className="grid-batch-bar" onClick={e => e.stopPropagation()}>
                    <span className="grid-batch-count">{selected.size} selected</span>
                    <button className="text-btn batch-fav" disabled={selected.size === 0}
                        onClick={() => onBatchFavorite(selectedPaths(), true)}>♥ Favorite</button>
                    <button className="text-btn" disabled={selected.size === 0}
                        onClick={() => onBatchFavorite(selectedPaths(), false)}>♡ Unfavorite</button>
                    <span className="grid-batch-tag">
                        <input
                            list="grid-tag-options"
                            placeholder="tag…"
                            value={batchTag}
                            onChange={e => setBatchTag(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applyBatchTag(); }}
                        />
                        <datalist id="grid-tag-options">
                            {tagNames.map(tag => <option key={tag} value={tag} />)}
                        </datalist>
                        <button className="text-btn" disabled={selected.size === 0 || !batchTag.trim()} onClick={applyBatchTag}>Tag</button>
                    </span>
                    {quickMoveFolders.map((folder, i) => folder && (
                        <button key={i} className="text-btn" disabled={selected.size === 0}
                            title={folder}
                            onClick={() => { onBatchMove(selectedPaths(), i); clearSelection(); }}>
                            → {folder.split(/[/\\]/).pop()}
                        </button>
                    ))}
                    <button className="text-btn batch-delete" disabled={selected.size === 0}
                        onClick={() => { onBatchDelete(selectedPaths()); clearSelection(); }}>
                        <FiTrash2 size={12} /> Delete
                    </button>
                    <button className="text-btn" onClick={clearSelection}><FiX size={12} /> Clear</button>
                </div>
            )}

            <div
                className="grid-container"
                style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
                onClick={e => e.stopPropagation()}
            >
                {topSpace > 0 && <div style={{ gridColumn: '1/-1', height: topSpace }} />}
                {slice.map(({ file, index }) => (
                    <button
                        key={file.path}
                        className={`grid-cell ${index === currentIndex ? 'active' : ''} ${selected.has(file.path) ? 'selected' : ''}`}
                        style={{ height: cellSize }}
                        title={file.name}
                        onClick={() => {
                            if (selectMode) toggleSelected(file.path);
                            else onSelect(index);
                        }}
                    >
                        {file.type === 'image' ? (
                            <img src={getDisplayUrl(file.path, 512)} loading="lazy" decoding="async" alt={file.name} />
                        ) : (
                            <div className="grid-video-tile">
                                <FiFilm size={28} />
                                <span>{file.name}</span>
                            </div>
                        )}
                        {favorites.has(file.path) && <FiHeart className="grid-heart" />}
                        {selectMode && <span className="grid-checkbox">{selected.has(file.path) ? '✓' : ''}</span>}
                    </button>
                ))}
                {bottomSpace > 0 && <div style={{ gridColumn: '1/-1', height: bottomSpace }} />}
            </div>
        </div>
    );
}

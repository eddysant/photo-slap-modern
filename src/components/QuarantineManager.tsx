import { useCallback, useEffect, useMemo, useState } from 'react';
import { FiArrowLeft, FiDownload, FiFolder, FiRefreshCw, FiRotateCcw, FiTrash2 } from 'react-icons/fi';

interface QuarantineManagerProps {
    roots: string[];
    onBack: () => void;
    onRestored: (paths: string[]) => void;
}

const fileName = (filePath: string) => filePath.split(/[/\\]/).pop() ?? filePath;
const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function QuarantineManager({ roots, onBack, onRestored }: QuarantineManagerProps) {
    const [entries, setEntries] = useState<QuarantineEntry[] | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [isBusy, setIsBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setEntries(null);
        setSelected(new Set());
        try {
            setEntries(await window.api.listQuarantine(roots));
        } catch {
            setEntries([]);
            setNotice('The quarantine could not be read.');
        }
    }, [roots]);

    useEffect(() => { refresh(); }, [refresh]);

    const selectedPaths = useMemo(() => [...selected], [selected]);
    const toggleSelected = (quarantinePath: string) => {
        setSelected(previous => {
            const next = new Set(previous);
            if (next.has(quarantinePath)) next.delete(quarantinePath);
            else next.add(quarantinePath);
            return next;
        });
    };

    const restore = async (paths: string[]) => {
        if (paths.length === 0) return;
        setIsBusy(true);
        setNotice(null);
        try {
            const restored = await window.api.restoreQuarantine(roots, paths);
            onRestored(restored.map(file => file.restoredPath));
            const collisionCount = restored.filter(file => {
                const entry = entries?.find(candidate => candidate.quarantinePath === file.quarantinePath);
                return entry && entry.originalPath !== file.restoredPath;
            }).length;
            setNotice(`${restored.length} file${restored.length === 1 ? '' : 's'} restored${collisionCount ? `; ${collisionCount} renamed to avoid a collision` : ''}. Health scan refreshed.`);
            await refresh();
        } catch {
            setNotice('The selected files could not be restored.');
        } finally {
            setIsBusy(false);
        }
    };

    const permanentlyDelete = async (paths: string[]) => {
        if (paths.length === 0) return;
        if (!window.confirm(`Permanently delete ${paths.length} quarantined file${paths.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
        setIsBusy(true);
        setNotice(null);
        try {
            const deleted = await window.api.deleteQuarantine(roots, paths);
            setNotice(`${deleted.length} quarantined file${deleted.length === 1 ? '' : 's'} permanently deleted.`);
            await refresh();
        } catch {
            setNotice('The selected files could not be deleted.');
        } finally {
            setIsBusy(false);
        }
    };

    const exportManifest = async () => {
        const saved = await window.api.exportQuarantine(roots);
        setNotice(saved ? 'Quarantine manifest exported.' : 'Manifest export cancelled.');
    };

    return (
        <div className="quarantine-manager">
            <div className="quarantine-toolbar">
                <button className="retro-button compact" onClick={onBack}><FiArrowLeft /> Health report</button>
                <button className="retro-button compact" disabled={isBusy || selected.size === 0} onClick={() => restore(selectedPaths)}><FiRotateCcw /> Restore selected</button>
                <button className="retro-button compact danger" disabled={isBusy || selected.size === 0} onClick={() => permanentlyDelete(selectedPaths)}><FiTrash2 /> Delete selected</button>
                <button className="retro-button compact" disabled={isBusy || !entries?.length} onClick={exportManifest}><FiDownload /> Export manifest</button>
                <button className="control-btn" disabled={isBusy} onClick={refresh} aria-label="Refresh quarantine"><FiRefreshCw /></button>
            </div>
            <div className="quarantine-summary">
                <label>
                    <input
                        type="checkbox"
                        checked={!!entries?.length && selected.size === entries.length}
                        onChange={event => setSelected(event.target.checked ? new Set(entries?.map(entry => entry.quarantinePath) ?? []) : new Set())}
                    />
                    Select all
                </label>
                <span>{entries?.length ?? 0} quarantined · {selected.size} selected</span>
                {notice && <strong>{notice}</strong>}
            </div>
            <div className="quarantine-list">
                {entries === null && <div className="health-loading"><div className="loading-spinner" /><p>Reading quarantine manifest…</p></div>}
                {entries?.length === 0 && <div className="health-clear">The quarantine is empty.</div>}
                {entries?.map(entry => (
                    <div className={`quarantine-row ${selected.has(entry.quarantinePath) ? 'selected' : ''}`} key={entry.quarantinePath}>
                        <input type="checkbox" checked={selected.has(entry.quarantinePath)} onChange={() => toggleSelected(entry.quarantinePath)} aria-label={`Select ${fileName(entry.originalPath)}`} />
                        <div className="quarantine-copy">
                            <strong>{fileName(entry.originalPath)}</strong>
                            <span>Original: {entry.originalPath}</span>
                            <small>Quarantined: {entry.quarantinePath}</small>
                            <small>{formatBytes(entry.size)}{entry.quarantinedAt ? ` · ${new Date(entry.quarantinedAt).toLocaleString()}` : ' · Legacy entry'}</small>
                        </div>
                        <div className="quarantine-row-actions">
                            <button className="control-btn" disabled={isBusy} onClick={() => window.api.showInFolder(entry.quarantinePath)} title="Show quarantined file"><FiFolder /></button>
                            <button className="control-btn" disabled={isBusy} onClick={() => restore([entry.quarantinePath])} title="Restore"><FiRotateCcw /></button>
                            <button className="control-btn danger" disabled={isBusy} onClick={() => permanentlyDelete([entry.quarantinePath])} title="Delete permanently"><FiTrash2 /></button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

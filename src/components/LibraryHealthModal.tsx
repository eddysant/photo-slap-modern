import { useEffect, useMemo, useState } from 'react';
import { FiActivity, FiArchive, FiDownload, FiFolder, FiTool, FiX } from 'react-icons/fi';
import { QuarantineManager } from './QuarantineManager';

interface LibraryHealthModalProps {
    isOpen: boolean;
    roots: string[];
    onClose: () => void;
    onReport: (report: LibraryHealthReport) => void;
    onFilesMoved: (paths: string[]) => void;
    onMetadataRemoved: (paths: string[]) => void;
    onFilesRestored: (paths: string[]) => void;
}

const CATEGORY_LABELS: Record<LibraryHealthCategory, string> = {
    corrupt: 'Corrupt / unreadable',
    tiny: 'Suspiciously tiny',
    unsupported: 'Unsupported media',
    'missing-date': 'Missing capture date',
    'orphan-sidecar': 'Orphaned sidecar entry',
};

export function LibraryHealthModal({ isOpen, roots, onClose, onReport, onFilesMoved, onMetadataRemoved, onFilesRestored }: LibraryHealthModalProps) {
    const [report, setReport] = useState<LibraryHealthReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeCategory, setActiveCategory] = useState<LibraryHealthCategory | 'all'>('all');
    const [scanRevision, setScanRevision] = useState(0);
    const [isRepairing, setIsRepairing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [showQuarantine, setShowQuarantine] = useState(false);

    useEffect(() => { if (!isOpen) setShowQuarantine(false); }, [isOpen]);

    useEffect(() => {
        if (!isOpen || roots.length === 0) return;
        let cancelled = false;
        setReport(null);
        setError(null);
        setNotice(null);
        setActiveCategory('all');
        window.api.scanLibraryHealth(roots)
            .then(result => {
                if (!cancelled) {
                    setReport(result);
                    onReport(result);
                }
            })
            .catch(() => { if (!cancelled) setError('The library health scan could not be completed.'); });
        return () => { cancelled = true; };
    }, [isOpen, roots, scanRevision, onReport]);

    const repair = async (action: LibraryHealthRepairAction) => {
        if (!report) return;
        const isQuarantine = action === 'quarantine-corrupt';
        const count = isQuarantine ? report.summary.corrupt : report.summary['orphan-sidecar'];
        if (count === 0) return;
        const prompt = isQuarantine
            ? `Move ${count} corrupt file${count === 1 ? '' : 's'} into a hidden .photo-slap-quarantine folder?`
            : `Remove ${count} missing file entr${count === 1 ? 'y' : 'ies'} from the library sidecars?`;
        if (!window.confirm(prompt)) return;
        setIsRepairing(true);
        setNotice(null);
        try {
            const paths = isQuarantine
                ? report.issues.filter(issue => issue.category === 'corrupt').map(issue => issue.path)
                : undefined;
            const result = await window.api.repairLibraryHealth(roots, action, paths);
            if (result.quarantined.length > 0) onFilesMoved(result.quarantined.map(file => file.source));
            if (result.removed.length > 0) onMetadataRemoved(result.removed);
            const changes = [
                result.quarantined.length > 0 ? `${result.quarantined.length} file${result.quarantined.length === 1 ? '' : 's'} quarantined` : '',
                result.removed.length > 0 ? `${result.removed.length} sidecar entr${result.removed.length === 1 ? 'y' : 'ies'} cleaned` : '',
            ].filter(Boolean).join('; ');
            setNotice(`${changes || 'No items changed'}. Running a fresh scan…`);
            setScanRevision(value => value + 1);
        } catch {
            setNotice('The repair could not be completed. No remaining items were changed.');
        } finally {
            setIsRepairing(false);
        }
    };

    const exportCsv = async () => {
        if (!report) return;
        const saved = await window.api.exportLibraryHealth(report);
        setNotice(saved ? 'CSV report saved.' : 'CSV export cancelled.');
    };

    const shown = useMemo(() => report?.issues.filter(issue => activeCategory === 'all' || issue.category === activeCategory) ?? [], [report, activeCategory]);
    if (!isOpen) return null;

    return (
        <div className="health-overlay" role="dialog" aria-modal="true" aria-label="Library health">
            <div className="health-modal">
                <header className="health-header">
                    <div>{showQuarantine ? <FiArchive /> : <FiActivity />}<span>{showQuarantine ? 'Quarantine Manager' : 'Library Health'}</span></div>
                    <button className="control-btn" onClick={onClose} aria-label="Close library health"><FiX size={22} /></button>
                </header>
                {showQuarantine ? (
                    <QuarantineManager
                        roots={roots}
                        onBack={() => setShowQuarantine(false)}
                        onRestored={paths => {
                            onFilesRestored(paths);
                            setScanRevision(value => value + 1);
                        }}
                    />
                ) : (
                    <>
                {!report && !error && <div className="health-loading"><div className="loading-spinner" /><p>Inspecting media and sidecars…</p></div>}
                {error && <div className="health-loading"><p>{error}</p></div>}
                {report && (
                    <>
                        <div className="health-summary">
                            <button className={activeCategory === 'all' ? 'active' : ''} onClick={() => setActiveCategory('all')}><strong>{report.issues.length}</strong><span>All issues</span></button>
                            {(Object.keys(CATEGORY_LABELS) as LibraryHealthCategory[]).map(category => (
                                <button key={category} className={activeCategory === category ? 'active' : ''} onClick={() => setActiveCategory(category)}>
                                    <strong>{report.summary[category]}</strong><span>{CATEGORY_LABELS[category]}</span>
                                </button>
                            ))}
                        </div>
                        <div className="health-scan-note">Scanned {report.scannedFiles} supported media file{report.scannedFiles === 1 ? '' : 's'} in {report.roots.length} root{report.roots.length === 1 ? '' : 's'}.</div>
                        <div className="health-actions">
                            <button className="retro-button compact" disabled={isRepairing || report.summary.corrupt === 0} onClick={() => repair('quarantine-corrupt')}>
                                <FiArchive /> Move corrupt aside
                            </button>
                            <button className="retro-button compact" disabled={isRepairing || report.summary['orphan-sidecar'] === 0} onClick={() => repair('remove-orphans')}>
                                <FiTool /> Remove orphan entries
                            </button>
                            <button className="retro-button compact" disabled={isRepairing} onClick={exportCsv}><FiDownload /> Export CSV</button>
                            <button className="retro-button compact" disabled={isRepairing} onClick={() => setShowQuarantine(true)}><FiArchive /> Manage quarantine</button>
                            {notice && <span className="health-notice">{notice}</span>}
                        </div>
                        <div className="health-issues">
                            {shown.length === 0 ? <div className="health-clear">No issues in this category.</div> : shown.map((issue, i) => (
                                <div className="health-issue" key={`${issue.category}-${issue.path}-${i}`}>
                                    <div className="health-issue-copy">
                                        <span className={`health-badge ${issue.category}`}>{CATEGORY_LABELS[issue.category]}</span>
                                        <strong title={issue.path}>{issue.path.split(/[/\\]/).pop()}</strong>
                                        <small title={issue.path}>{issue.path}</small>
                                        <p>{issue.detail}</p>
                                    </div>
                                    <button className="control-btn" onClick={() => window.api.showInFolder(issue.path)} title="Show in folder"><FiFolder /></button>
                                </div>
                            ))}
                        </div>
                    </>
                )}
                    </>
                )}
            </div>
        </div>
    );
}

import { useState, useEffect, useRef } from 'react';
import { FiX, FiCheck, FiImage, FiLayers } from 'react-icons/fi';
import { getFileUrl } from '../utils';
import type { PHashMessage, PHashRequest } from '../workers/phashWorker';

interface DedupeModalProps {
    isOpen: boolean;
    onClose: () => void;
    rootPath: string; // To know where to scan
    /** Called whenever files are moved to Trash so the slideshow can drop them. */
    onFilesDeleted?: (paths: string[]) => void;
}

interface DuplicateGroup {
    hash: string;
    files: string[]; // Absolute paths
    type: 'exact' | 'similar';
}

// Hamming distance <= this over the 256-bit blockhash counts as "similar"
const SIMILARITY_THRESHOLD = 12;

const hammingDistance = (a: string, b: string) => {
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) dist++;
    }
    return dist;
};

export function DedupeModal({ isOpen, onClose, rootPath, onFilesDeleted }: DedupeModalProps) {
    const [step, setStep] = useState<'intro' | 'scanning' | 'review' | 'done'>('intro');
    const [scanType, setScanType] = useState<'exact' | 'similar'>('exact');
    const [progress, setProgress] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

    // Files of the current group still in contention. We always compare the
    // first two: the "keeper" (left) vs the next challenger (right). Whoever
    // survives keeps facing the rest of the group, so groups of any size get
    // fully reviewed.
    const [groupFiles, setGroupFiles] = useState<string[]>([]);

    const workerRef = useRef<Worker | null>(null);

    // Reset when opened
    useEffect(() => {
        if (isOpen) {
            setStep('intro');
            setGroups([]);
            setProgress(0);
        }
    }, [isOpen]);

    // Kill any in-flight hashing when the modal closes/unmounts
    useEffect(() => {
        if (!isOpen && workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        return () => {
            workerRef.current?.terminate();
            workerRef.current = null;
        };
    }, [isOpen]);

    // Load the files of the group under review
    useEffect(() => {
        if (step === 'review') {
            setGroupFiles(groups[currentGroupIndex]?.files ?? []);
        }
    }, [step, currentGroupIndex, groups]);

    const enterReview = (found: DuplicateGroup[]) => {
        if (found.length > 0) {
            setGroups(found);
            setCurrentGroupIndex(0);
            setStep('review');
        } else {
            setStatusMsg(scanType === 'exact' ? 'No exact duplicates found!' : 'No similar photos found!');
            setStep('done');
        }
    };

    const startScan = async () => {
        setStep('scanning');
        setProgress(0);
        setStatusMsg('Scanning files...');

        try {
            if (scanType === 'exact') {
                const result = await window.api.scanDedupeExact(rootPath);
                enterReview(result.map(g => ({ ...g, type: 'exact' as const })));
                return;
            }

            // Perceptual hashing, done in a worker to keep the UI responsive
            setStatusMsg('Finding images...');
            const files = await window.api.scanDedupeFiles(rootPath);

            setStatusMsg(`Processing ${files.length} images...`);
            setProgress(0);

            const worker = new Worker(new URL('../workers/phashWorker.ts', import.meta.url), { type: 'module' });
            workerRef.current = worker;

            const hashes = await new Promise<{ path: string; hash: string }[]>((resolve, reject) => {
                worker.onmessage = (e: MessageEvent<PHashMessage>) => {
                    if (e.data.type === 'progress') {
                        setProgress(Math.round((e.data.done / e.data.total) * 100));
                    } else {
                        resolve(e.data.hashes);
                    }
                };
                worker.onerror = (e) => reject(new Error(e.message));
                worker.postMessage({ paths: files } satisfies PHashRequest);
            });
            worker.terminate();
            workerRef.current = null;

            // Group by similarity (naive O(n^2) comparison)
            setStatusMsg('Comparing...');
            const newGroups: DuplicateGroup[] = [];
            const processed = new Set<string>();

            for (let i = 0; i < hashes.length; i++) {
                if (processed.has(hashes[i].path)) continue;

                const currentGroup = [hashes[i].path];
                processed.add(hashes[i].path);

                for (let j = i + 1; j < hashes.length; j++) {
                    if (processed.has(hashes[j].path)) continue;

                    if (hammingDistance(hashes[i].hash, hashes[j].hash) <= SIMILARITY_THRESHOLD) {
                        currentGroup.push(hashes[j].path);
                        processed.add(hashes[j].path);
                    }
                }

                if (currentGroup.length > 1) {
                    newGroups.push({ hash: hashes[i].hash, files: currentGroup, type: 'similar' });
                }
            }

            enterReview(newGroups);
        } catch (e) {
            console.error(e);
            setStatusMsg('Error during scan.');
            setStep('done');
        }
    };

    const nextGroup = () => {
        if (currentGroupIndex < groups.length - 1) {
            setCurrentGroupIndex(prev => prev + 1);
        } else {
            setStatusMsg('All duplicates resolved!');
            setStep('done');
        }
    };

    const deleteFile = async (path: string) => {
        const ok = await window.api.deleteFile(path);
        if (ok) onFilesDeleted?.([path]);
        return ok;
    };

    const leftImage = groupFiles[0] ?? '';
    const rightImage = groupFiles[1] ?? '';

    const resolveConflict = async (keep: 'left' | 'right' | 'both' | 'skip') => {
        if (keep === 'skip') {
            nextGroup();
            return;
        }

        let remaining: string[];
        if (keep === 'left') {
            await deleteFile(rightImage);
            remaining = [leftImage, ...groupFiles.slice(2)];
        } else if (keep === 'right') {
            await deleteFile(leftImage);
            remaining = groupFiles.slice(1);
        } else {
            // Keep both: the challenger is safe; the keeper faces the next one
            remaining = [leftImage, ...groupFiles.slice(2)];
        }

        if (remaining.length >= 2) {
            setGroupFiles(remaining);
        } else {
            nextGroup();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="dedupe-modal-overlay">
            <div className="dedupe-modal">
                <div className="dedupe-header">
                    <span>DUPLICATE FINDER</span>
                    <button className="close-btn" onClick={onClose}><FiX /></button>
                </div>

                <div className="dedupe-content">
                    {step === 'intro' && (
                        <div className="step-intro">
                            <p>Scan your folder for duplicates to save space.</p>

                            <div className="scan-options">
                                <button
                                    className={`scan-toggle ${scanType === 'exact' ? 'active' : ''}`}
                                    onClick={() => setScanType('exact')}
                                >
                                    <FiLayers size={32} />
                                    <span>Exact Match</span>
                                    <small>Finds identical files (100% match)</small>
                                </button>

                                <button
                                    className={`scan-toggle ${scanType === 'similar' ? 'active' : ''}`}
                                    onClick={() => setScanType('similar')}
                                >
                                    <FiImage size={32} />
                                    <span>Similar Photos</span>
                                    <small>Finds visual matches (even if resized)</small>
                                </button>
                            </div>

                            <button className="balatro-button primary" onClick={startScan} disabled={!rootPath}>
                                START SCAN
                            </button>
                        </div>
                    )}

                    {step === 'scanning' && (
                        <div className="step-scanning">
                            <div className="spinner"></div>
                            <h3>{statusMsg}</h3>
                            {scanType === 'similar' && (
                                <div className="progress-bar-container">
                                    <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'review' && (
                        <div className="step-review">
                            <div className="progress-indicator">
                                Reviewing Group {currentGroupIndex + 1} / {groups.length}
                                {groupFiles.length > 2 && ` — ${groupFiles.length} files in group`}
                            </div>

                            <div className="compare-container">
                                {/* LEFT */}
                                <div className="compare-card">
                                    <div className="img-wrapper">
                                        <img src={getFileUrl(leftImage)} alt="Left" />
                                    </div>
                                    <div className="card-actions">
                                        <button className="keep-btn" onClick={() => resolveConflict('left')}>
                                            <FiCheck /> KEEP THIS
                                        </button>
                                    </div>
                                </div>

                                {/* RIGHT */}
                                <div className="compare-card">
                                    <div className="img-wrapper">
                                        <img src={getFileUrl(rightImage)} alt="Right" />
                                    </div>
                                    <div className="card-actions">
                                        <button className="keep-btn" onClick={() => resolveConflict('right')}>
                                            <FiCheck /> KEEP THIS
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="group-actions">
                                <button className="text-btn" onClick={() => resolveConflict('both')}>Keep Both</button>
                                <button className="text-btn" onClick={() => resolveConflict('skip')}>Skip Group</button>
                            </div>
                        </div>
                    )}

                    {step === 'done' && (
                        <div className="step-done">
                            <FiCheck size={64} color="#00ff00" />
                            <h3>{statusMsg}</h3>
                            <button className="balatro-button" onClick={onClose}>CLOSE</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

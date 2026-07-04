import React, { useState, useEffect } from 'react';
import { FiX, FiCheck, FiImage, FiLayers } from 'react-icons/fi';
import { bmvbhash } from 'blockhash-core';
import { getFileUrl } from '../utils';

interface DedupeModalProps {
    isOpen: boolean;
    onClose: () => void;
    rootPath: string; // To know where to scan
}

interface DuplicateGroup {
    hash: string;
    files: string[]; // Absolute paths
    type: 'exact' | 'similar';
}

export const DedupeModal: React.FC<DedupeModalProps> = ({ isOpen, onClose, rootPath }) => {
    const [step, setStep] = useState<'intro' | 'scanning' | 'review' | 'done'>('intro');
    const [scanType, setScanType] = useState<'exact' | 'similar'>('exact');
    const [progress, setProgress] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

    // Review State: show the first two files of the current group side-by-side.
    // Groups with > 2 files only get their first pair compared (v1 limitation).
    const currentGroup = groups[currentGroupIndex];
    const leftImage = currentGroup?.files[0] ?? '';
    const rightImage = currentGroup?.files[1] ?? '';

    // Reset when opened
    useEffect(() => {
        if (isOpen) {
            setStep('intro');
            setGroups([]);
            setProgress(0);
        }
    }, [isOpen]);

    const startScan = async () => {
        setStep('scanning');
        setProgress(0);
        setStatusMsg('Scanning files...');

        try {
            if (scanType === 'exact') {
                const result = await window.api.scanDedupeExact(rootPath);
                if (result.length > 0) {
                    setGroups(result.map(g => ({ ...g, type: 'exact' as const })));
                    setStep('review');
                    setCurrentGroupIndex(0);
                } else {
                    setStep('done');
                    setStatusMsg('No exact duplicates found!');
                }
            } else {
                // PERCEPTUAL HASHING (Renderer side)
                setStatusMsg('Finding images...');
                const files: string[] = await window.api.scanDedupeFiles(rootPath);

                setStatusMsg(`Processing ${files.length} images...`);
                setProgress(0);

                const hashes: { path: string; hash: string }[] = [];

                // Process in chunks to avoid blocking UI
                const CHUNK_SIZE = 10;
                for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                    const chunk = files.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (f: string) => {
                        try {
                            const hash = await computePHash(f);
                            if (hash) hashes.push({ path: f, hash });
                        } catch {
                            console.warn("Failed to hash", f);
                        }
                    }));

                    setProgress(Math.round(((i + chunk.length) / files.length) * 100));
                    // Yield to UI
                    await new Promise(r => setTimeout(r, 0));
                }

                // Find similarities (Naive O(n^2))
                setStatusMsg('Comparing...');
                const newGroups: DuplicateGroup[] = [];
                const processed = new Set<string>();

                for (let i = 0; i < hashes.length; i++) {
                    if (processed.has(hashes[i].path)) continue;

                    const currentGroup = [hashes[i].path];
                    processed.add(hashes[i].path);

                    for (let j = i + 1; j < hashes.length; j++) {
                        if (processed.has(hashes[j].path)) continue;

                        const dist = hammingDistance(hashes[i].hash, hashes[j].hash);
                        if (dist <= 12) { // Threshold
                            currentGroup.push(hashes[j].path);
                            processed.add(hashes[j].path);
                        }
                    }

                    if (currentGroup.length > 1) {
                        newGroups.push({ hash: hashes[i].hash, files: currentGroup, type: 'similar' });
                    }
                }

                if (newGroups.length > 0) {
                    setGroups(newGroups);
                    setStep('review');
                    setCurrentGroupIndex(0);
                } else {
                    setStep('done');
                    setStatusMsg('No similar photos found!');
                }
            }
        } catch (e) {
            console.error(e);
            setStatusMsg('Error during scan.');
            setStep('done');
        }
    };

    const computePHash = async (src: string): Promise<string | null> => {
        return new Promise((resolve) => {
            const img = new Image();
            img.src = getFileUrl(src);
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 16;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(null);
                ctx.drawImage(img, 0, 0, 16, 16);
                const imageData = ctx.getImageData(0, 0, 16, 16);
                const hash = bmvbhash(imageData, 16);
                resolve(hash);
            };
            img.onerror = () => resolve(null);
        });
    };

    const hammingDistance = (a: string, b: string) => {
        let dist = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) dist++;
        }
        return dist;
    };

    const resolveConflict = async (keep: 'left' | 'right' | 'both' | 'skip') => {

        if (keep === 'left') {
            // Delete right
            await window.api.deleteFile(rightImage);
        } else if (keep === 'right') {
            // Delete left
            await window.api.deleteFile(leftImage);
        }
        // Both/Skip = do nothing

        // If group had > 2 items, we theoretically need to compare the winner against the next one.
        // But for this V1 implementation, we just assume pairs or handle "Next"
        // Ideally: remove distinct deleted items from group.files, if > 1 remaining, shift rightImage.

        // Simple logic: Move to next group
        if (currentGroupIndex < groups.length - 1) {
            setCurrentGroupIndex(prev => prev + 1);
        } else {
            setStep('done');
            setStatusMsg('All duplicates resolved!');
            // Refresh app file list? (Handled by App automatically if file watcher? No, probably need manual refresh or just acceptable staleness)
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
};

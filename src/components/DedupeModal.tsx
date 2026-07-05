import { useState, useEffect, useRef } from 'react';
import { FiX, FiCheck } from 'react-icons/fi';
import { bmvbhash } from 'blockhash-core';
import { getFileUrl, formatBytes } from '../utils';
import { groupSimilar } from '../similarity';
import type { PHashMessage, PHashRequest } from '../workers/phashWorker';

const isVideoFile = (p: string) => /\.(mp4|mov|webm|mkv|ogg|gifv)$/i.test(p);

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

interface Dimensions { w: number; h: number }
interface FileInfo { size: number; mtimeMs: number }

// One knob instead of "Exact vs Similar": level 0 is byte-identical, the
// rest are perceptual-hash Hamming-distance thresholds of increasing laxity.
const STRICTNESS_LEVELS = [
    {
        label: 'Exact',
        desc: 'Byte-for-byte identical files only. The safest level — a match is always a true duplicate.',
        threshold: null as number | null,
    },
    {
        label: 'Strict',
        desc: 'Visually identical photos — the same image resized, re-saved, or converted.',
        threshold: 4,
    },
    {
        label: 'Normal',
        desc: 'Near-identical photos — minor edits, small crops, or light color tweaks.',
        threshold: 12,
    },
    {
        label: 'Loose',
        desc: 'Similar-looking photos — bursts and same-scene shots. Expect some false matches; review carefully.',
        threshold: 20,
    },
];

// Exact duplicates can be videos; render those with a real video element
function MediaPreview({ path, alt, onDimensions }: {
    path: string;
    alt: string;
    onDimensions: (path: string, dims: Dimensions) => void;
}) {
    if (isVideoFile(path)) {
        return (
            <video
                src={getFileUrl(path)}
                muted
                controls
                loop
                preload="metadata"
                onLoadedMetadata={e => onDimensions(path, { w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            />
        );
    }
    return (
        <img
            src={getFileUrl(path)}
            alt={alt}
            onLoad={e => onDimensions(path, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
    );
}

// Filename, folder, size, and dimensions — the facts needed to pick a
// winner. Whichever side is bigger/higher-res gets highlighted.
function FileMeta({ path, info, dims, otherInfo, otherDims }: {
    path: string;
    info?: FileInfo;
    dims?: Dimensions;
    otherInfo?: FileInfo;
    otherDims?: Dimensions;
}) {
    const parts = path.split(/[/\\]/);
    const name = parts.pop();
    const folder = parts.join('/');
    const sizeBetter = !!(info && otherInfo && info.size > otherInfo.size);
    const resBetter = !!(dims && otherDims && dims.w * dims.h > otherDims.w * otherDims.h);

    return (
        <div className="file-meta">
            <div className="file-meta-name" title={path}>{name}</div>
            <div className="file-meta-path" title={folder}>{folder}</div>
            <div className="file-meta-stats">
                <span className={sizeBetter ? 'meta-better' : ''}>
                    {info ? formatBytes(info.size) : '…'}
                </span>
                <span className={resBetter ? 'meta-better' : ''}>
                    {dims ? `${dims.w}×${dims.h}` : '…'}
                </span>
            </div>
        </div>
    );
}

export function DedupeModal({ isOpen, onClose, rootPath, onFilesDeleted }: DedupeModalProps) {
    const [step, setStep] = useState<'intro' | 'scanning' | 'review' | 'done'>('intro');
    const [strictness, setStrictness] = useState(0);
    const [includeVideos, setIncludeVideos] = useState(true);
    const [progress, setProgress] = useState(0);
    const [statusMsg, setStatusMsg] = useState('');
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

    // Files of the current group still in contention. We always compare the
    // first two: the "keeper" (left) vs the next challenger (right). Whoever
    // survives keeps facing the rest of the group, so groups of any size get
    // fully reviewed.
    const [groupFiles, setGroupFiles] = useState<string[]>([]);

    // Compare-card metadata (sizes from the main process, dimensions from
    // the loaded media elements)
    const [fileInfos, setFileInfos] = useState<Record<string, FileInfo>>({});
    const [dimensions, setDimensions] = useState<Record<string, Dimensions>>({});

    const workerRef = useRef<Worker | null>(null);

    // The folder to scan: defaults to the open slideshow folder, but can be
    // picked here directly (the modal is reachable from the start screen).
    const [scanRoot, setScanRoot] = useState(rootPath);

    // Reset when opened
    useEffect(() => {
        if (isOpen) {
            setStep('intro');
            setGroups([]);
            setProgress(0);
            setScanRoot(rootPath);
            setFileInfos({});
            setDimensions({});
        }
    }, [isOpen, rootPath]);

    const chooseFolder = async () => {
        const dir = await window.api.pickDirectory();
        if (dir) setScanRoot(dir);
    };

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

    const leftImage = groupFiles[0] ?? '';
    const rightImage = groupFiles[1] ?? '';

    // Fetch sizes for the pair on display
    useEffect(() => {
        const missing = [leftImage, rightImage].filter(p => p && !(p in fileInfos));
        if (missing.length > 0) {
            window.api.getFileInfo(missing).then(info => {
                setFileInfos(prev => ({ ...prev, ...info }));
            });
        }
    }, [leftImage, rightImage, fileInfos]);

    const recordDimensions = (path: string, dims: Dimensions) => {
        setDimensions(prev => (prev[path]?.w === dims.w && prev[path]?.h === dims.h ? prev : { ...prev, [path]: dims }));
    };

    const enterReview = (found: DuplicateGroup[]) => {
        if (found.length > 0) {
            setGroups(found);
            setCurrentGroupIndex(0);
            setStep('review');
        } else {
            setStatusMsg(strictness === 0 ? 'No exact duplicates found!' : 'No similar files found!');
            setStep('done');
        }
    };

    // Perceptual hash of a sampled video frame (~1s in, to skip black intro
    // frames). Runs on the main thread — video decoding isn't worker-friendly.
    const hashVideoFrame = (src: string): Promise<string | null> => new Promise(resolve => {
        const video = document.createElement('video');
        let settled = false;
        const finish = (hash: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute('src');
            video.load();
            resolve(hash);
        };
        const timer = setTimeout(() => finish(null), 15000);
        video.muted = true;
        video.preload = 'auto';
        // media:// is a different origin than the app; without CORS mode the
        // canvas is tainted and getImageData throws
        video.crossOrigin = 'anonymous';
        video.onloadeddata = () => {
            video.currentTime = Math.min(1, (video.duration || 0) / 2);
        };
        video.onseeked = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 16;
                canvas.height = 16;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) return finish(null);
                ctx.drawImage(video, 0, 0, 16, 16);
                finish(bmvbhash(ctx.getImageData(0, 0, 16, 16), 16));
            } catch {
                finish(null);
            }
        };
        video.onerror = () => finish(null);
        video.src = getFileUrl(src);
    });

    const startScan = async () => {
        setStep('scanning');
        setProgress(0);
        setStatusMsg('Scanning files...');

        try {
            const level = STRICTNESS_LEVELS[strictness];

            if (level.threshold === null) {
                const result = await window.api.scanDedupeExact(scanRoot, includeVideos);
                enterReview(result.map(g => ({ ...g, type: 'exact' as const })));
                return;
            }

            // Similarity scan: images hashed in a worker; videos (optional)
            // hashed by a sampled frame on the main thread.
            setStatusMsg('Finding files...');
            const images = await window.api.scanDedupeFiles(scanRoot, 'images');
            const videos = includeVideos ? await window.api.scanDedupeFiles(scanRoot, 'videos') : [];
            const total = images.length + videos.length;

            setStatusMsg(`Processing ${total} files...`);
            setProgress(0);

            const worker = new Worker(new URL('../workers/phashWorker.ts', import.meta.url), { type: 'module' });
            workerRef.current = worker;

            const imageHashes = await new Promise<{ path: string; hash: string }[]>((resolve, reject) => {
                worker.onmessage = (e: MessageEvent<PHashMessage>) => {
                    if (e.data.type === 'progress') {
                        setProgress(Math.round((e.data.done / total) * 100));
                    } else {
                        resolve(e.data.hashes);
                    }
                };
                worker.onerror = (e) => reject(new Error(e.message));
                worker.postMessage({ paths: images } satisfies PHashRequest);
            });
            worker.terminate();
            workerRef.current = null;

            const hashes = [...imageHashes];
            for (let i = 0; i < videos.length; i++) {
                const hash = await hashVideoFrame(videos[i]);
                if (hash) hashes.push({ path: videos[i], hash });
                setProgress(Math.round(((images.length + i + 1) / total) * 100));
            }

            // Group by similarity, transitively (A~B and B~C land together)
            setStatusMsg('Comparing...');
            const newGroups: DuplicateGroup[] = groupSimilar(hashes, level.threshold)
                .map(files => ({ hash: '', files, type: 'similar' as const }));

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

    const level = STRICTNESS_LEVELS[strictness];

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
                            <div className="dedupe-folder">
                                <span className="dedupe-folder-name">
                                    {scanRoot ? scanRoot.split(/[/\\]/).pop() : 'No folder selected'}
                                </span>
                                <button className="text-btn" onClick={chooseFolder}>Choose Folder…</button>
                            </div>

                            <div className="strictness-block">
                                <div className="strictness-title">
                                    MATCH STRICTNESS: <span className="strictness-value">{level.label.toUpperCase()}</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={3}
                                    step={1}
                                    value={strictness}
                                    onChange={e => setStrictness(parseInt(e.target.value))}
                                    className="scrubber strictness-slider"
                                />
                                <div className="strictness-labels">
                                    {STRICTNESS_LEVELS.map((l, i) => (
                                        <button
                                            key={l.label}
                                            className={`text-btn ${i === strictness ? 'strictness-active' : ''}`}
                                            onClick={() => setStrictness(i)}
                                        >
                                            {l.label}
                                        </button>
                                    ))}
                                </div>
                                <p className="strictness-desc">{level.desc}</p>
                            </div>

                            <div className="dedupe-videos-option">
                                <label className="checkbox-control">
                                    <input type="checkbox" checked={includeVideos} onChange={() => setIncludeVideos(v => !v)} />
                                    Include Videos
                                </label>
                                <small>
                                    {strictness === 0
                                        ? 'Videos are matched by full file contents.'
                                        : 'Videos are matched by a sampled frame — re-encoded copies of the same clip will match.'}
                                </small>
                            </div>

                            <button className="balatro-button primary" onClick={startScan} disabled={!scanRoot}>
                                START SCAN
                            </button>
                        </div>
                    )}

                    {step === 'scanning' && (
                        <div className="step-scanning">
                            <div className="spinner"></div>
                            <h3>{statusMsg}</h3>
                            {strictness > 0 && (
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
                                        <MediaPreview path={leftImage} alt="Left" onDimensions={recordDimensions} />
                                    </div>
                                    <FileMeta
                                        path={leftImage}
                                        info={fileInfos[leftImage]}
                                        dims={dimensions[leftImage]}
                                        otherInfo={fileInfos[rightImage]}
                                        otherDims={dimensions[rightImage]}
                                    />
                                    <div className="card-actions">
                                        <button className="keep-btn" onClick={() => resolveConflict('left')}>
                                            <FiCheck /> KEEP THIS
                                        </button>
                                    </div>
                                </div>

                                {/* RIGHT */}
                                <div className="compare-card">
                                    <div className="img-wrapper">
                                        <MediaPreview path={rightImage} alt="Right" onDimensions={recordDimensions} />
                                    </div>
                                    <FileMeta
                                        path={rightImage}
                                        info={fileInfos[rightImage]}
                                        dims={dimensions[rightImage]}
                                        otherInfo={fileInfos[leftImage]}
                                        otherDims={dimensions[leftImage]}
                                    />
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

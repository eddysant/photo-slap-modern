import { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSettings, FiPlay, FiPause, FiSkipBack, FiSkipForward, FiTrash2, FiVolume2, FiVolumeX } from 'react-icons/fi'
import './App.css'
import { DedupeModal } from './components/DedupeModal'
import { IntroScreen } from './components/IntroScreen'
import { SettingsMenu, MediaFilter, ControlsPosition } from './components/SettingsMenu'
import { Toast } from './components/Toast'
import { usePersistedState } from './hooks/usePersistedState'
import { slideTransitions, TransitionStyle } from './transitions'
import { getFileUrl } from './utils'

const KEN_BURNS_ANIMATIONS = ['kb-pan-left', 'kb-pan-right', 'kb-pan-up', 'kb-pan-down', 'kb-zoom-in', 'kb-zoom-out'];

function App() {
  const [files, setFiles] = useState<MediaFile[]>([])
  const [allFiles, setAllFiles] = useState<MediaFile[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [currentDir, setCurrentDir] = useState('')
  const [isDedupeOpen, setIsDedupeOpen] = useState(false)
  const [exifData, setExifData] = useState<ExifData | null>(null)
  const [kenBurnsClass, setKenBurnsClass] = useState('')

  // Settings (persisted across launches via electron-store)
  const [isShuffle, setIsShuffle] = usePersistedState('isShuffle', false)
  const [slideDuration, setSlideDuration] = usePersistedState('slideDuration', 3000)
  const [mediaFilter, setMediaFilter] = usePersistedState<MediaFilter>('mediaFilter', 'both')
  const [isSmart, setIsSmart] = usePersistedState('isSmart', false)
  const [isSmartVideoEnabled, setIsSmartVideoEnabled] = usePersistedState('isSmartVideoEnabled', true)
  const [isStretch, setIsStretch] = usePersistedState('isStretch', false)
  const [isKenBurns, setIsKenBurns] = usePersistedState('isKenBurns', false)
  const [isExifEnabled, setIsExifEnabled] = usePersistedState('isExifEnabled', false)
  const [transitionStyle, setTransitionStyle] = usePersistedState<TransitionStyle>('transitionStyle', 'fade')
  const [volume, setVolume] = usePersistedState('volume', 1)
  const [isMuted, setIsMuted] = usePersistedState('isMuted', false)
  const [controlsPosition, setControlsPosition] = usePersistedState<ControlsPosition>('controlsPosition', 'bottom')

  // Toast
  const [toast, setToast] = useState<string | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const applyFiltersAndSort = useCallback((unfiltered: MediaFile[], currentFilter: string, isShuffled: boolean) => {
    let filtered = unfiltered;
    if (currentFilter === 'photos') {
      filtered = unfiltered.filter(f => f.type === 'image');
    } else if (currentFilter === 'videos') {
      filtered = unfiltered.filter(f => f.type === 'video');
    }

    // Sort naturally first
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (isShuffled) {
      // Fisher-Yates shuffle
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
    }

    setFiles(sorted);
    setCurrentIndex(0);
  }, []);

  const ingestScanResult = useCallback((result: { paths: string[], files: MediaFile[], errors: string[] }) => {
    if (result.errors.length > 0) {
      showToast(`${result.errors.length} folder${result.errors.length > 1 ? 's' : ''} couldn't be read`);
    }

    if (result.files.length > 0) {
      if (result.paths.length > 0) {
        setCurrentDir(result.paths[0]);
      }
      setAllFiles(result.files);
      applyFiltersAndSort(result.files, mediaFilter, isShuffle);
      setIsPlaying(false); // Default to paused
    } else {
      showToast('No media files found in that folder');
    }
  }, [applyFiltersAndSort, mediaFilter, isShuffle, showToast]);

  const handleOpenDirectory = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await window.api.openDirectory();
      if (result) ingestScanResult(result); // null = dialog cancelled
    } catch (error) {
      console.error("Error opening directory:", error);
      showToast('Something went wrong opening that folder');
    } finally {
      setIsLoading(false);
    }
  }, [ingestScanResult, showToast]);

  // Load a directory passed on the command line (or PHOTO_SLAP_DIR in dev)
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    window.api.getAutoOpen()
      .then(result => { if (result) ingestScanResult(result); })
      .catch(e => console.error('Auto-open failed:', e));
  }, [ingestScanResult]);

  const nextSlide = useCallback(() => {
    setFiles((currentFiles) => {
      if (currentFiles.length === 0) return currentFiles;
      setCurrentIndex((prev) => (prev + 1) % currentFiles.length);
      return currentFiles;
    });
  }, []);

  const prevSlide = useCallback(() => {
    setFiles((currentFiles) => {
      if (currentFiles.length === 0) return currentFiles;
      setCurrentIndex((prev) => (prev - 1 + currentFiles.length) % currentFiles.length);
      return currentFiles;
    });
  }, []);

  const togglePlay = useCallback(() => setIsPlaying(prev => !prev), []);

  const toggleShuffle = () => {
    const newShuffle = !isShuffle;
    setIsShuffle(newShuffle);
    applyFiltersAndSort(allFiles, mediaFilter, newShuffle);
  };

  const handleMediaFilterChange = (newFilter: MediaFilter) => {
    setMediaFilter(newFilter);
    applyFiltersAndSort(allFiles, newFilter, isShuffle);
  };

  const deleteCurrentFile = useCallback(async () => {
    if (files.length === 0) return;
    const fileToDelete = files[currentIndex];
    const success = await window.api.deleteFile(fileToDelete.path);
    if (success) {
      setAllFiles(prev => prev.filter(f => f.path !== fileToDelete.path));
      setFiles(prev => {
        const newFiles = prev.filter((_, i) => i !== currentIndex);
        if (currentIndex >= newFiles.length) {
          setCurrentIndex(Math.max(0, newFiles.length - 1));
        }
        return newFiles;
      });
    }
  }, [files, currentIndex]);

  // Dedupe moved files to Trash: drop them from the slideshow too
  const handleFilesDeleted = useCallback((deleted: string[]) => {
    const del = new Set(deleted);
    setAllFiles(prev => prev.filter(f => !del.has(f.path)));
    setFiles(prev => {
      const newFiles = prev.filter(f => !del.has(f.path));
      setCurrentIndex(ci => Math.min(ci, Math.max(0, newFiles.length - 1)));
      return newFiles;
    });
  }, []);

  const toggleSettings = () => setIsSettingsOpen(prev => !prev);

  // Video Scrubber Logic
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [isUserPaused, setIsUserPaused] = useState(false);

  // Per-slide state reset + EXIF fetch + Ken Burns randomization
  useEffect(() => {
    setVideoProgress(0);
    setIsUserPaused(false);
    setExifData(null);

    if (files[currentIndex]?.type === 'image') {
      if (isExifEnabled) {
        window.api.getExif(files[currentIndex].path).then(data => {
          setExifData(data);
        });
      }
      if (isKenBurns) {
        setKenBurnsClass(KEN_BURNS_ANIMATIONS[Math.floor(Math.random() * KEN_BURNS_ANIMATIONS.length)]);
      }
    }
  }, [currentIndex, isExifEnabled, isKenBurns, files]);

  // Sync Volume
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted, currentIndex]); // Update when file changes too to ensure new video gets volume

  // Sync Video Playback
  useEffect(() => {
    // Sync both main and optional background video
    const els = [videoRef.current, bgVideoRef.current];
    els.forEach(el => {
      if (el) {
        if (isUserPaused) el.pause();
        else el.play().catch(() => { });
      }
    });
  }, [isUserPaused, currentIndex]);

  const toggleVideoPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsUserPaused(prev => !prev);
  };

  const handleVideoTimeUpdate = () => {
    if (videoRef.current) {
      const progress = (videoRef.current.currentTime / videoRef.current.duration) * 100;
      setVideoProgress(progress || 0);
    }
  };

  const handleVideoSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = (time / 100) * videoRef.current.duration;
      setVideoProgress(time);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => setIsMuted(!isMuted);

  // Video End Handler
  const handleVideoEnded = () => {
    if (isPlaying) {
      nextSlide();
    }
  };

  // Preloading Logic
  const preloadRefs = useRef<HTMLImageElement[]>([]);

  useEffect(() => {
    if (files.length === 0) return;

    const PRELOAD_COUNT = 10;
    const newPreloads: HTMLImageElement[] = [];

    for (let i = 1; i <= PRELOAD_COUNT; i++) {
      const nextIndex = (currentIndex + i) % files.length;
      const file = files[nextIndex];
      const fileUrl = getFileUrl(file.path);

      if (file.type === 'image') {
        const img = new Image();
        img.src = fileUrl;
        newPreloads.push(img);
      }
    }

    preloadRefs.current = newPreloads;
  }, [currentIndex, files]);

  // Auto-hide controls logic
  const [showControls, setShowControls] = useState(false);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringControlsRef = useRef(false);

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);

    controlsTimeoutRef.current = setTimeout(() => {
      if (!isHoveringControlsRef.current) {
        setShowControls(false);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    }
  }, [handleMouseMove]);

  // Slideshow timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isPlaying && files.length > 0) {
      const current = files[currentIndex];
      // Only start timer if it's an image. Videos handle their own progression via onEnded.
      if (current && current.type === 'image') {
        interval = setInterval(nextSlide, slideDuration);
      }
    }
    return () => clearInterval(interval);
  }, [isPlaying, files, currentIndex, slideDuration, nextSlide]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
          nextSlide();
          break;
        case 'ArrowLeft':
          prevSlide();
          break;
        case ' ':
          e.preventDefault(); // Don't scroll or re-trigger focused buttons
          togglePlay();
          break;
        case 'Delete':
        case 'Backspace':
          deleteCurrentFile();
          break;
        case 'Escape':
          setIsSettingsOpen(false);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide, togglePlay, deleteCurrentFile]);

  // Update window title
  useEffect(() => {
    if (files.length > 0 && files[currentIndex]) {
      document.title = files[currentIndex].name;
    } else {
      document.title = 'photo-slap';
    }
  }, [currentIndex, files]);

  // Listen for menu events
  useEffect(() => {
    const cleanupOpen = window.api.on('menu:open-directory', () => {
      handleOpenDirectory();
    });
    const cleanupShow = window.api.on('menu:show-in-finder', () => {
      if (files.length > 0) {
        window.api.showInFolder(files[currentIndex].path);
      }
    });
    return () => {
      cleanupOpen();
      cleanupShow();
    };
  }, [handleOpenDirectory, files, currentIndex]);

  if (files.length === 0) {
    return (
      <div className="app-container">
        <div className="title-bar">photo-slap</div>
        <IntroScreen isLoading={isLoading} onOpenDirectory={handleOpenDirectory} />
        <Toast message={toast} />
      </div>
    );
  }

  const currentFile = files[currentIndex];
  const fileUrl = getFileUrl(currentFile.path);
  const currentTransition = slideTransitions[transitionStyle];

  return (
    <div className="app-container">
      <SettingsMenu
        isOpen={isSettingsOpen}
        onClose={toggleSettings}
        mediaFilter={mediaFilter}
        onMediaFilterChange={handleMediaFilterChange}
        isShuffle={isShuffle}
        onToggleShuffle={toggleShuffle}
        isSmart={isSmart}
        onToggleSmart={() => setIsSmart(!isSmart)}
        isSmartVideoEnabled={isSmartVideoEnabled}
        onToggleSmartVideo={() => setIsSmartVideoEnabled(!isSmartVideoEnabled)}
        isStretch={isStretch}
        onToggleStretch={() => setIsStretch(!isStretch)}
        isKenBurns={isKenBurns}
        onToggleKenBurns={() => setIsKenBurns(!isKenBurns)}
        isExifEnabled={isExifEnabled}
        onToggleExif={() => setIsExifEnabled(!isExifEnabled)}
        transitionStyle={transitionStyle}
        onTransitionChange={setTransitionStyle}
        slideDuration={slideDuration}
        onDurationChange={setSlideDuration}
        controlsPosition={controlsPosition}
        onControlsPositionChange={setControlsPosition}
        onShowInFinder={() => {
          window.api.showInFolder(currentFile.path);
          toggleSettings();
        }}
        onFindDuplicates={() => {
          toggleSettings();
          setIsDedupeOpen(true);
        }}
      />

      {/* Title Bar with Filename */}
      <div className={`title-bar ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`}>
        {currentFile.name}
      </div>

      <div className={`file-info ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`} style={controlsPosition === 'left' ? {} : { top: '50px' }}>
        {currentIndex + 1} / {files.length}
      </div>

      {isExifEnabled && exifData && (
        <div className={`exif-overlay ${controlsPosition === 'left' ? 'position-left' : ''}`}>
          {exifData.make && <div>CAM: {exifData.make} {exifData.model}</div>}
          {exifData.lens && <div>LENS: {exifData.lens}</div>}
          <div style={{ display: 'flex', gap: '10px' }}>
            {exifData.iso && <div>ISO: {exifData.iso}</div>}
            {exifData.aperture && <div>ƒ/{exifData.aperture}</div>}
            {exifData.shutter && <div>{exifData.shutter}s</div>}
          </div>
          {exifData.date && <div style={{ fontSize: '0.7em', marginTop: '4px', opacity: 0.8 }}>{exifData.date}</div>}
        </div>
      )}

      <div className="viewer-container" onClick={() => isSettingsOpen && setIsSettingsOpen(false)}>
        {/* "sync" keeps the old slide mounted underneath while the star wipes in over it */}
        <AnimatePresence mode={transitionStyle === 'star' ? 'sync' : 'wait'}>
          <motion.div
            key={currentFile.path}
            initial={currentTransition.initial}
            animate={currentTransition.animate}
            exit={currentTransition.exit}
            transition={currentTransition.transition}
            style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {/* Smart Background Layer */}
            {isSmart && (currentFile.type === 'image' || isSmartVideoEnabled) && (
              <div className="smart-background-layer">
                {currentFile.type === 'video' ? (
                  <video
                    ref={bgVideoRef}
                    src={fileUrl}
                    className="blurred-media"
                    muted
                    autoPlay
                    loop
                  />
                ) : (
                  <img src={fileUrl} className="blurred-media" alt="" />
                )}
              </div>
            )}

            {currentFile.type === 'video' ? (
              <>
                <video
                  ref={(el) => {
                    videoRef.current = el;
                    if (el) {
                      el.volume = volume;
                      el.muted = isMuted;
                    }
                  }}
                  src={fileUrl}
                  className="media-element"
                  controls={false}
                  autoPlay // Always autoplay
                  loop={!isPlaying} // Loop ONLY if not in slideshow mode. If slideshow, play once then next.
                  onTimeUpdate={handleVideoTimeUpdate}
                  onEnded={handleVideoEnded}
                  onClick={toggleVideoPause}
                  style={{
                    cursor: 'pointer',
                    objectFit: 'contain',
                    width: isStretch ? '100%' : 'auto',
                    height: isStretch ? '100%' : 'auto',
                    maxWidth: '100%',
                    maxHeight: '100%'
                  }}
                />
                {isUserPaused && (
                  <div className="pause-overlay">
                    <FiPlay size={48} />
                  </div>
                )}
              </>
            ) : (
              <img
                src={fileUrl}
                className={`media-element ${isKenBurns ? `ken-burns-active ${kenBurnsClass}` : ''}`}
                alt={currentFile.name}
                style={{
                  objectFit: isStretch ? 'contain' : (isKenBurns ? 'cover' : 'contain'),
                  width: isStretch || isKenBurns ? '100%' : 'auto',
                  height: isStretch || isKenBurns ? '100%' : 'auto',
                  maxWidth: isStretch ? '100%' : (isKenBurns ? 'none' : '100%'),
                  maxHeight: isStretch ? '100%' : (isKenBurns ? 'none' : '100%')
                }}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className={`controls-overlay ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`} style={{ pointerEvents: isSettingsOpen ? 'none' : 'auto' }}>
        <div
          className="control-bar"
          style={{ pointerEvents: 'auto' }}
          onMouseEnter={() => isHoveringControlsRef.current = true}
          onMouseLeave={() => {
            isHoveringControlsRef.current = false;
          }}
        >

          {/* Conditional Scrubber */}
          {currentFile.type === 'video' && (
            <div className="scrubber-container">
              <input
                type="range"
                min="0"
                max="100"
                step="0.1"
                value={videoProgress}
                onChange={handleVideoSeek}
                className="scrubber"
              />

              <div className="volume-control">
                <button className="control-btn small" onClick={toggleMute}>
                  {isMuted || volume === 0 ? <FiVolumeX size={16} /> : <FiVolume2 size={16} />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="volume-slider"
                />
              </div>
            </div>
          )}

          <button className="control-btn" onClick={prevSlide} title="Previous (Left Arrow)">
            <FiSkipBack size={24} />
          </button>

          <button className={`control-btn ${isPlaying ? 'active' : ''}`} onClick={togglePlay} title="Play/Pause (Space)">
            {isPlaying ? <FiPause size={24} /> : <FiPlay size={24} />}
          </button>

          <button className="control-btn" onClick={nextSlide} title="Next (Right Arrow)">
            <FiSkipForward size={24} />
          </button>

          <div style={{ width: 1, height: 24, background: 'rgba(255,255,255,0.2)', margin: '0 8px' }} />

          <button className={`control-btn ${isSettingsOpen ? 'active' : ''}`} onClick={toggleSettings} title="Settings">
            <FiSettings size={20} />
          </button>

          <button className="control-btn danger" onClick={deleteCurrentFile} title="Delete (Del/Backspace)">
            <FiTrash2 size={20} />
          </button>
        </div>
      </div>

      <DedupeModal
        isOpen={isDedupeOpen}
        onClose={() => setIsDedupeOpen(false)}
        rootPath={currentDir}
        onFilesDeleted={handleFilesDeleted}
      />

      <Toast message={toast} />
    </div>
  )
}

export default App

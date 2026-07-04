import { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSettings, FiPlay, FiPause, FiSkipBack, FiSkipForward, FiTrash2, FiLayers, FiVolume2, FiVolumeX, FiFolder } from 'react-icons/fi'
import './App.css'
import { DedupeModal } from './components/DedupeModal'
import { getFileUrl } from './utils'

// Classic 5-point star, as [x, y] percentages of the slide box.
const STAR_POINTS = [
  [50, 0], [61, 35], [98, 35], [68, 57], [79, 91],
  [50, 70], [21, 91], [32, 57], [2, 35], [39, 35],
]

// Star scaled around the center. scale 0 = collapsed to a point,
// scale 4 = big enough that the star's inner edges clear the screen corners.
const starPolygon = (scale: number) =>
  `polygon(${STAR_POINTS.map(([x, y]) => `${50 + (x - 50) * scale}% ${50 + (y - 50) * scale}%`).join(', ')})`

function App() {
  const [files, setFiles] = useState<MediaFile[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isShuffle, setIsShuffle] = useState(false)
  const [slideDuration, setSlideDuration] = useState(3000)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [currentDir, setCurrentDir] = useState('')
  const [isDedupeOpen, setIsDedupeOpen] = useState(false)
  const [controlsPosition, setControlsPosition] = useState<'bottom' | 'left'>('bottom')

  // Filtering State
  const [allFiles, setAllFiles] = useState<MediaFile[]>([])
  const [mediaFilter, setMediaFilter] = useState<'both' | 'photos' | 'videos'>('both')

  // Smart Background State
  const [isSmart, setIsSmart] = useState(false);
  const [isSmartVideoEnabled, setIsSmartVideoEnabled] = useState(true);
  const [isStretch, setIsStretch] = useState(false);
  const [isKenBurns, setIsKenBurns] = useState(false);
  const [isExifEnabled, setIsExifEnabled] = useState(false);
  const [transitionStyle, setTransitionStyle] = useState<'fade' | 'slide' | 'zoom' | 'flip' | 'star'>('fade');
  const [exifData, setExifData] = useState<ExifData | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [kenBurnsClass, setKenBurnsClass] = useState('');

  useEffect(() => {
    // Load settings
    const loadSettings = async () => {
      try {
        const storedShuffle = await window.api.getStore('isShuffle');
        const storedDuration = await window.api.getStore('slideDuration');
        const storedSmart = await window.api.getStore('isSmart');
        const storedSmartVideo = await window.api.getStore('isSmartVideoEnabled');
        const storedMediaFilter = await window.api.getStore('mediaFilter');
        const storedTransition = await window.api.getStore('transitionStyle');

        if (storedShuffle !== undefined) setIsShuffle(storedShuffle);
        if (storedDuration !== undefined) setSlideDuration(storedDuration);
        if (storedSmart !== undefined) setIsSmart(storedSmart);
        if (storedSmartVideo !== undefined) setIsSmartVideoEnabled(storedSmartVideo);
        if (storedMediaFilter !== undefined) setMediaFilter(storedMediaFilter);
        if (storedTransition !== undefined) setTransitionStyle(storedTransition);
        const storedStretch = await window.api.getStore('isStretch');
        if (storedStretch !== undefined) setIsStretch(storedStretch);
        const storedKenBurns = await window.api.getStore('isKenBurns');
        if (storedKenBurns !== undefined) setIsKenBurns(storedKenBurns);
        const storedExif = await window.api.getStore('isExifEnabled');
        if (storedExif !== undefined) setIsExifEnabled(storedExif);
        const storedVolume = await window.api.getStore('volume');
        if (storedVolume !== undefined) setVolume(storedVolume);
        const storedMuted = await window.api.getStore('isMuted');
        if (storedMuted !== undefined) setIsMuted(storedMuted);
        const storedControlsPosition = await window.api.getStore('controlsPosition');
        if (storedControlsPosition !== undefined) setControlsPosition(storedControlsPosition);
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    }
    loadSettings();
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

  const handleOpenDirectory = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await window.api.openDirectory();
      if (result && result.files.length > 0) {
        if (result.paths && result.paths.length > 0) {
          setCurrentDir(result.paths[0]);
        }
        setAllFiles(result.files);
        applyFiltersAndSort(result.files, mediaFilter, isShuffle);
        setIsPlaying(false); // Default to paused
      }
    } catch (error) {
      console.error("Error opening directory:", error);
    } finally {
      setIsLoading(false);
    }
  }, [applyFiltersAndSort, mediaFilter, isShuffle]);

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
    window.api.setStore('isShuffle', newShuffle);
    applyFiltersAndSort(allFiles, mediaFilter, newShuffle);
  };

  const handleMediaFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFilter = e.target.value as 'both' | 'photos' | 'videos';
    setMediaFilter(newFilter);
    window.api.setStore('mediaFilter', newFilter);
    applyFiltersAndSort(allFiles, newFilter, isShuffle);
  };

  const toggleSmart = () => {
    const newSmart = !isSmart;
    setIsSmart(newSmart);
    window.api.setStore('isSmart', newSmart);
  };

  const toggleSmartVideo = () => {
    const newSmartVideo = !isSmartVideoEnabled;
    setIsSmartVideoEnabled(newSmartVideo);
    window.api.setStore('isSmartVideoEnabled', newSmartVideo);
  };

  const toggleStretch = () => {
    const newStretch = !isStretch;
    setIsStretch(newStretch);
    window.api.setStore('isStretch', newStretch);
  };

  const toggleKenBurns = () => {
    const newKenBurns = !isKenBurns;
    setIsKenBurns(newKenBurns);
    window.api.setStore('isKenBurns', newKenBurns);
  };

  const toggleExif = () => {
    const newExif = !isExifEnabled;
    setIsExifEnabled(newExif);
    window.api.setStore('isExifEnabled', newExif);
  };

  const handleTransitionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newTransition = e.target.value as 'fade' | 'slide' | 'zoom' | 'flip' | 'star';
    setTransitionStyle(newTransition);
    window.api.setStore('transitionStyle', newTransition);
  };

  const handleControlsPositionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newPosition = e.target.value as 'bottom' | 'left';
    setControlsPosition(newPosition);
    window.api.setStore('controlsPosition', newPosition);
  };

  const deleteCurrentFile = useCallback(async () => {
    if (files.length === 0) return;
    const fileToDelete = files[currentIndex];
    const success = await window.api.deleteFile(fileToDelete.path);
    if (success) {
      setFiles(prev => {
        const newFiles = prev.filter((_, i) => i !== currentIndex);
        if (currentIndex >= newFiles.length) {
          setCurrentIndex(Math.max(0, newFiles.length - 1));
        }
        return newFiles;
      });
    }
  }, [files, currentIndex]);

  const toggleSettings = () => setIsSettingsOpen(!isSettingsOpen);

  const handleDurationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newDuration = parseInt(e.target.value);
    setSlideDuration(newDuration);
    window.api.setStore('slideDuration', newDuration);
  };

  // Video Scrubber Logic
  const videoRef = useRef<HTMLVideoElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [isUserPaused, setIsUserPaused] = useState(false);

  useEffect(() => {
    setVideoProgress(0);
    setIsUserPaused(false);
    setExifData(null); // Reset EXIF

    // Fetch EXIF if enabled
    if (files[currentIndex]?.type === 'image') {
      if (isExifEnabled) {
        window.api.getExif(files[currentIndex].path).then(data => {
          setExifData(data);
        });
      }
      if (isKenBurns) {
        const animations = ['kb-pan-left', 'kb-pan-right', 'kb-pan-up', 'kb-pan-down', 'kb-zoom-in', 'kb-zoom-out'];
        const randomAnim = animations[Math.floor(Math.random() * animations.length)];
        setKenBurnsClass(randomAnim);
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
    window.api.setStore('volume', newVolume);
    if (newVolume > 0 && isMuted) {
      setIsMuted(false);
      window.api.setStore('isMuted', false);
    }
  };

  const toggleMute = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    window.api.setStore('isMuted', newMuted);
  };

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
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
    let interval: any;
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
          if (isSettingsOpen) setIsSettingsOpen(false);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide, togglePlay, deleteCurrentFile, isSettingsOpen]);

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
        {/* Settings Menu in Empty State too if needed, or just let them open dir first */}
        <div className="title-bar">photo-slap</div>

        {/* Balatro Intro Screen */}
        <div className="balatro-container">
          <div className="crt-overlay" />

          <div className="balatro-title">
            PHOTO<br />SLAP
          </div>

          <button className="balatro-button" onClick={handleOpenDirectory} disabled={isLoading}>
            {isLoading ? 'SCANNING...' : 'OPEN FOLDER'}
          </button>
        </div>
      </div>
    );
  }

  const currentFile = files[currentIndex];
  const fileUrl = getFileUrl(currentFile.path);

  // Define dynamic framer-motion variants based on the selected transition style
  const motionVariants: Record<string, any> = {
    fade: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0.3 }
    },
    slide: {
      initial: { x: '100%', opacity: 0 },
      animate: { x: 0, opacity: 1 },
      exit: { x: '-100%', opacity: 0 },
      transition: { type: "tween", duration: 0.4, ease: "easeInOut" }
    },
    zoom: {
      initial: { scale: 0.8, opacity: 0 },
      animate: { scale: 1, opacity: 1 },
      exit: { scale: 1.2, opacity: 0 },
      transition: { duration: 0.4 }
    },
    flip: {
      initial: { rotateY: 90, opacity: 0 },
      animate: { rotateY: 0, opacity: 1 },
      exit: { rotateY: -90, opacity: 0 },
      transition: { duration: 0.5 }
    },
    // Star wipe: the incoming slide is revealed through a growing star
    // while the outgoing slide stays fully visible underneath. Requires
    // AnimatePresence mode "sync" so both slides are mounted at once.
    star: {
      initial: { clipPath: starPolygon(0), zIndex: 2 },
      animate: { clipPath: starPolygon(4), zIndex: 2 },
      exit: {
        zIndex: 1,
        // Stay visible under the wipe, then disappear once fully covered.
        opacity: 0,
        transition: { duration: 0.01, delay: 0.65 }
      },
      transition: { duration: 0.6, ease: 'easeInOut' }
    }
  };

  const currentTransition = motionVariants[transitionStyle];

  return (
    <div className="app-container">
      {/* Settings Menu */}
      <AnimatePresence>
        {isSettingsOpen && (
          <motion.div
            className="settings-menu"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <div className="settings-header">Options</div>

            <div className="setting-item">
              <div className="setting-label">Media Filter</div>
              <select className="setting-control" value={mediaFilter} onChange={handleMediaFilterChange}>
                <option value="both">Both</option>
                <option value="photos">Photos Only</option>
                <option value="videos">Videos Only</option>
              </select>
            </div>

            <div className="setting-item">
              <label className="checkbox-control">
                <input type="checkbox" checked={isShuffle} onChange={toggleShuffle} />
                Shuffle Photos
              </label>
            </div>

            <div className="setting-item">
              <label className="checkbox-control">
                <input type="checkbox" checked={isSmart} onChange={toggleSmart} />
                Smart Background
              </label>
            </div>

            {isSmart && (
              <div className="setting-item" style={{ paddingLeft: '24px', marginTop: '-4px' }}>
                <label className="checkbox-control">
                  <input type="checkbox" checked={isSmartVideoEnabled} onChange={toggleSmartVideo} />
                  Smart Background (Videos)
                </label>
              </div>
            )}

            <div className="setting-item">
              <label className="checkbox-control">
                <input type="checkbox" checked={isStretch} onChange={toggleStretch} />
                Force Stretch
              </label>
            </div>

            <div className="setting-item">
              <label className="checkbox-control">
                <input type="checkbox" checked={isKenBurns} onChange={toggleKenBurns} />
                Ken Burns Effect
              </label>
            </div>

            <div className="setting-item">
              <label className="checkbox-control">
                <input type="checkbox" checked={isExifEnabled} onChange={toggleExif} />
                Show EXIF Data
              </label>
            </div>

            <div className="setting-item">
              <div className="setting-label">Slide Transition</div>
              <select className="setting-control" value={transitionStyle} onChange={handleTransitionChange}>
                <option value="fade">Fade</option>
                <option value="slide">Slide</option>
                <option value="zoom">Zoom</option>
                <option value="flip">Flip</option>
                <option value="star">Star Wipe</option>
              </select>
            </div>

            <div className="setting-item">
              <div className="setting-label">Slide Duration</div>
              <select className="setting-control" value={slideDuration} onChange={handleDurationChange}>
                <option value={2000}>2 Seconds</option>
                <option value={3000}>3 Seconds</option>
                <option value={5000}>5 Seconds</option>
                <option value={10000}>10 Seconds</option>
                <option value={30000}>30 Seconds</option>
                <option value={60000}>1 Minute</option>
              </select>
            </div>

            <div className="setting-item">
              <div className="setting-label">Controls Position</div>
              <select className="setting-control" value={controlsPosition} onChange={handleControlsPositionChange}>
                <option value="bottom">Bottom Center</option>
                <option value="left">Left Side</option>
              </select>
            </div>

            <div className="setting-item">
              <button
                className="balatro-button"
                style={{ width: '100%', fontSize: '14px', padding: '10px' }}
                onClick={() => {
                  if (files.length > 0) {
                    window.api.showInFolder(files[currentIndex].path);
                    toggleSettings();
                  }
                }}
              >
                <FiFolder style={{ marginRight: 8 }} /> SHOW IN FINDER
              </button>
            </div>

            <div className="setting-item">
              <button
                className="balatro-button"
                style={{ width: '100%', fontSize: '14px', padding: '10px' }}
                onClick={() => {
                  toggleSettings();
                  setIsDedupeOpen(true);
                }}
              >
                <FiLayers style={{ marginRight: 8 }} /> FIND DUPLICATES
              </button>
            </div>

            <div style={{ marginTop: 'auto' }}>
              <button className="primary-button" style={{ width: '100%', justifyContent: 'center', fontFamily: 'Silkscreen' }} onClick={toggleSettings}>
                Close
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Title Bar with Filename */}
      <div className={`title-bar ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`}>
        {currentFile.name}
      </div>

      <div className={`file-info ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`} style={controlsPosition === 'left' ? {} : { top: '50px' }}> {/* Push down below title bar conceptually */}
        {currentIndex + 1} / {files.length}
      </div>


      {
        isExifEnabled && exifData && (
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
        )
      }

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
      />
    </div >
  )
}

export default App

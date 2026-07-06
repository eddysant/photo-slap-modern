import { useState, useEffect, useCallback, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSettings, FiPlay, FiPause, FiSkipBack, FiSkipForward, FiTrash2, FiVolume2, FiVolumeX, FiGrid, FiHeart } from 'react-icons/fi'
import './App.css'
import { DedupeModal } from './components/DedupeModal'
import { GridView } from './components/GridView'
import { IntroScreen } from './components/IntroScreen'
import { TagEditor } from './components/TagEditor'
import { SettingsMenu, MediaFilter, ControlsPosition, SortOrder } from './components/SettingsMenu'
import { Toast } from './components/Toast'
import { ZoomPan } from './components/ZoomPan'
import { usePersistedState } from './hooks/usePersistedState'
import { slideTransitions, TransitionStyle } from './transitions'
import { getFileUrl } from './utils'

const mergeScans = (results: ScanResult[]): ScanResult => ({
  paths: results.flatMap(r => r.paths),
  files: results.flatMap(r => r.files),
  errors: results.flatMap(r => r.errors),
})

const KEN_BURNS_ANIMATIONS = ['kb-pan-left', 'kb-pan-right', 'kb-pan-up', 'kb-pan-down', 'kb-zoom-in', 'kb-zoom-out'];

function App() {
  const [files, setFiles] = useState<MediaFile[]>([])
  const [allFiles, setAllFiles] = useState<MediaFile[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [currentDirs, setCurrentDirs] = useState<string[]>([])
  const [isDedupeOpen, setIsDedupeOpen] = useState(false)
  const [isGridOpen, setIsGridOpen] = useState(false)
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false)

  // Library metadata (favorites & tags) — lives in .photo-slap.json sidecar
  // files next to the photos, not in app storage
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [fileTags, setFileTags] = useState<Record<string, string[]>>({})
  const [tagNames, setTagNames] = useState<string[]>([])
  // Session-only view filters (not persisted — a hidden filter across
  // launches would look like lost photos)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [exifData, setExifData] = useState<ExifData | null>(null)
  const [kenBurnsClass, setKenBurnsClass] = useState('')
  // 1 = forward, -1 = backward; mirrors directional slide transitions
  const [direction, setDirection] = useState(1)

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
  const [sortOrder, setSortOrder] = usePersistedState<SortOrder>('sortOrder', 'name')
  const [quickMoveFolders, setQuickMoveFolders] = usePersistedState<(string | null)[]>('quickMoveFolders', [null, null, null])
  const [showSlideTimer, setShowSlideTimer] = usePersistedState('showSlideTimer', true)

  // Zoom state (per-slide; ZoomPan reports in so Ken Burns can pause)
  const [isZoomed, setIsZoomed] = useState(false)

  // Last opened folder(s), for the intro screen's Resume button
  const [lastDirs, setLastDirs] = useState<string[]>([])
  useEffect(() => {
    window.api.getStore('lastDirs')
      .then(v => { if (Array.isArray(v) && v.length > 0) setLastDirs(v); })
      .catch(() => { });
  }, []);

  // Toast
  const [toast, setToast] = useState<string | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const applyFiltersAndSort = useCallback((
    unfiltered: MediaFile[],
    currentFilter: string,
    isShuffled: boolean,
    sort: SortOrder,
    dates: Record<string, number> | null,
  ) => {
    let filtered = unfiltered;
    if (currentFilter === 'photos') {
      filtered = unfiltered.filter(f => f.type === 'image');
    } else if (currentFilter === 'videos') {
      filtered = unfiltered.filter(f => f.type === 'video');
    }

    // Natural name sort first — it's also the tiebreaker for equal dates
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (sort !== 'name' && dates) {
      sorted.sort((a, b) => {
        const da = dates[a.path] ?? 0;
        const db = dates[b.path] ?? 0;
        return sort === 'date-desc' ? db - da : da - db;
      });
    }

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

  // Date-taken lookup, fetched lazily the first time a date sort is used
  // and cached until a different folder is opened.
  const fileDatesRef = useRef<Record<string, number> | null>(null);
  const ensureDates = useCallback(async (fileList: MediaFile[]) => {
    if (!fileDatesRef.current) {
      showToast('Reading photo dates…');
      fileDatesRef.current = await window.api.getDates(fileList.map(f => f.path));
    }
    return fileDatesRef.current;
  }, [showToast]);

  // Set by Resume so the slideshow reopens at the slide it was left on
  const pendingIndexRef = useRef<number | null>(null);

  const ingestScanResult = useCallback((result: ScanResult) => {
    if (result.errors.length > 0) {
      showToast(`${result.errors.length} folder${result.errors.length > 1 ? 's' : ''} couldn't be read`);
    }

    if (result.files.length > 0) {
      setCurrentDirs(result.paths);
      fileDatesRef.current = null;
      setAllFiles(result.files); // the filter/sort effect below picks this up
      setIsPlaying(false); // Default to paused
      window.api.setStore('lastDirs', result.paths);
      setLastDirs(result.paths);
    } else {
      showToast('No media files found in that folder');
    }
  }, [showToast]);

  // Restore the pending resume position once the file list is ready
  useEffect(() => {
    if (files.length > 0 && pendingIndexRef.current !== null) {
      setCurrentIndex(Math.min(pendingIndexRef.current, files.length - 1));
      pendingIndexRef.current = null;
    }
  }, [files]);

  // Remember the current position per folder set (debounced)
  useEffect(() => {
    if (files.length === 0 || lastDirs.length === 0) return;
    const key = lastDirs.join('|');
    const timer = setTimeout(async () => {
      const positions = ((await window.api.getStore('resumePositions')) ?? {}) as Record<string, number>;
      positions[key] = currentIndex;
      window.api.setStore('resumePositions', positions);
    }, 500);
    return () => clearTimeout(timer);
  }, [currentIndex, lastDirs, files.length]);

  // Refs so favorite/tag EDITS don't re-derive the list (which would reset
  // the slide index); the favorites/tag FILTER toggles are real deps below.
  const favoritesRef = useRef(favorites);
  const fileTagsRef = useRef(fileTags);
  useEffect(() => {
    favoritesRef.current = favorites;
    fileTagsRef.current = fileTags;
  }, [favorites, fileTags]);

  // Derive the playable list whenever the source files or any list-shaping
  // setting changes (also handles persisted settings hydrating after launch).
  useEffect(() => {
    if (allFiles.length === 0) return;
    let cancelled = false;
    (async () => {
      let source = allFiles;
      if (favoritesOnly) source = source.filter(f => favoritesRef.current.has(f.path));
      if (tagFilter) source = source.filter(f => fileTagsRef.current[f.path]?.includes(tagFilter));
      if (source.length === 0) {
        showToast(favoritesOnly || tagFilter ? 'No files match the filters' : 'No media files');
      }
      const dates = sortOrder !== 'name' ? await ensureDates(allFiles) : null;
      if (!cancelled) applyFiltersAndSort(source, mediaFilter, isShuffle, sortOrder, dates);
    })();
    return () => { cancelled = true; };
  }, [allFiles, mediaFilter, isShuffle, sortOrder, favoritesOnly, tagFilter, ensureDates, applyFiltersAndSort, showToast]);

  // Load favorites/tags from the library sidecars whenever folders change
  useEffect(() => {
    if (currentDirs.length === 0) return;
    window.api.libraryLoad(currentDirs)
      .then(meta => {
        setFavorites(new Set(meta.favorites));
        setFileTags(meta.tags);
        setTagNames(meta.tagNames);
      })
      .catch(e => console.error('Failed to load library metadata:', e));
  }, [currentDirs]);

  // Debounced sidecar write-back
  const librarySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLibrarySave = useCallback((favs: Set<string>, tags: Record<string, string[]>, names: string[]) => {
    if (librarySaveTimer.current) clearTimeout(librarySaveTimer.current);
    librarySaveTimer.current = setTimeout(() => {
      window.api.librarySave(currentDirs, { favorites: [...favs], tags, tagNames: names })
        .catch(e => console.error('Failed to save library metadata:', e));
    }, 800);
  }, [currentDirs]);

  const toggleFavorite = useCallback(() => {
    const file = files[currentIndex];
    if (!file) return;
    const next = new Set(favorites);
    const nowFavorite = !next.has(file.path);
    if (nowFavorite) next.add(file.path);
    else next.delete(file.path);
    setFavorites(next);
    scheduleLibrarySave(next, fileTags, tagNames);
    // Un-favoriting while the favorites filter is on removes it from view
    if (!nowFavorite && favoritesOnly) {
      setFiles(prev => {
        const remaining = prev.filter(f => f.path !== file.path);
        setCurrentIndex(ci => Math.min(ci, Math.max(0, remaining.length - 1)));
        return remaining;
      });
    }
  }, [files, currentIndex, favorites, fileTags, tagNames, favoritesOnly, scheduleLibrarySave]);

  const setTagOnCurrent = useCallback((tag: string, ensureInVocabulary = false) => {
    const file = files[currentIndex];
    if (!file) return;
    const current = fileTags[file.path] ?? [];
    const nextTags = {
      ...fileTags,
      [file.path]: current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag],
    };
    if (nextTags[file.path].length === 0) delete nextTags[file.path];
    let nextNames = tagNames;
    if (ensureInVocabulary && !tagNames.includes(tag)) {
      nextNames = [...tagNames, tag].sort();
      setTagNames(nextNames);
    }
    setFileTags(nextTags);
    scheduleLibrarySave(favorites, nextTags, nextNames);
  }, [files, currentIndex, fileTags, tagNames, favorites, scheduleLibrarySave]);

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

  // Resume the folder(s) from the previous session, at the slide left off on
  const handleResume = useCallback(async () => {
    if (lastDirs.length === 0) return;
    try {
      setIsLoading(true);
      const results = await Promise.all(lastDirs.map(d => window.api.scanPath(d)));
      const valid = results.filter((r): r is ScanResult => r !== null);
      if (valid.length > 0) {
        const positions = ((await window.api.getStore('resumePositions')) ?? {}) as Record<string, number>;
        pendingIndexRef.current = positions[lastDirs.join('|')] ?? null;
        ingestScanResult(mergeScans(valid));
      } else {
        showToast("That folder doesn't exist anymore");
      }
    } finally {
      setIsLoading(false);
    }
  }, [lastDirs, ingestScanResult, showToast]);

  // Load a directory passed on the command line (or PHOTO_SLAP_DIR in dev)
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    window.api.getAutoOpen()
      .then(result => { if (result) ingestScanResult(result); })
      .catch(e => console.error('Auto-open failed:', e));
  }, [ingestScanResult]);

  // A second app launch with a folder argument opens it here
  useEffect(() => {
    return window.api.on('app:openScan', (_event, result: ScanResult) => {
      ingestScanResult(result);
    });
  }, [ingestScanResult]);

  // Drag-and-drop folders onto the window to open them
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const dropped = [...(e.dataTransfer?.files ?? [])];
      if (dropped.length === 0) return;
      const results: ScanResult[] = [];
      for (const file of dropped) {
        const path = window.api.getPathForFile(file);
        const result = path ? await window.api.scanPath(path) : null;
        if (result) results.push(result);
      }
      if (results.length > 0) {
        ingestScanResult(mergeScans(results));
      } else {
        showToast('Drop a folder to open it');
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [ingestScanResult, showToast]);

  // NOTE: keep these updaters pure (no setState inside another setState
  // updater) — StrictMode double-invokes updaters and impure ones make
  // navigation skip slides in dev.
  const nextSlide = useCallback(() => {
    setDirection(1);
    setCurrentIndex(prev => files.length === 0 ? prev : (prev + 1) % files.length);
  }, [files.length]);

  const prevSlide = useCallback(() => {
    setDirection(-1);
    setCurrentIndex(prev => files.length === 0 ? prev : (prev - 1 + files.length) % files.length);
  }, [files.length]);

  const togglePlay = useCallback(() => setIsPlaying(prev => !prev), []);

  // List-shaping settings just persist; the effect above re-derives the list
  const toggleShuffle = () => setIsShuffle(!isShuffle);
  const handleMediaFilterChange = (newFilter: MediaFilter) => setMediaFilter(newFilter);

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

  // Sync Video Playback: this effect is the single owner of play/pause for
  // both the main and blurred background video (the bg video deliberately
  // has no autoPlay attribute — it must not start while the main is paused,
  // e.g. when smart background is toggled on mid-pause).
  useEffect(() => {
    const els = [videoRef.current, bgVideoRef.current];
    els.forEach(el => {
      if (el) {
        if (isUserPaused) el.pause();
        else el.play().catch(() => { });
      }
    });
  }, [isUserPaused, currentIndex, isSmart, isSmartVideoEnabled]);

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
      const target = (time / 100) * videoRef.current.duration;
      videoRef.current.currentTime = target;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = target; // keep blur in sync
      setVideoProgress(time);
    }
  };

  // Jump the playing video by delta seconds (M/N shortcuts)
  const seekVideoBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video || !isFinite(video.duration)) return;
    const target = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, video.duration - 0.1));
    video.currentTime = target;
    if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    setVideoProgress((target / video.duration) * 100);
  }, []);

  const showCurrentInFinder = useCallback(() => {
    if (files.length > 0 && files[currentIndex]) {
      window.api.showInFolder(files[currentIndex].path);
    }
  }, [files, currentIndex]);

  // Quick-move the current file into one of the configured target folders
  const quickMove = useCallback(async (slot: number) => {
    const file = files[currentIndex];
    if (!file) return;
    const destDir = quickMoveFolders[slot];
    if (!destDir) {
      showToast(`No quick-move folder set for ${slot + 1} — see Settings`);
      return;
    }
    const result = await window.api.moveFile(file.path, destDir);
    if (result.ok) {
      showToast(`Moved to ${destDir.split(/[/\\]/).pop()}`);
      handleFilesDeleted([file.path]); // drop from the slideshow lists
    } else {
      showToast(result.error ?? 'Move failed');
    }
  }, [files, currentIndex, quickMoveFolders, showToast, handleFilesDeleted]);

  // Keep the display awake while a slideshow or a video is playing —
  // matters most when the show is running fullscreen on a TV.
  const currentIsVideo = files[currentIndex]?.type === 'video';
  useEffect(() => {
    const keepAwake = isPlaying || (currentIsVideo && !isUserPaused);
    window.api.setPowerBlocked(keepAwake);
  }, [isPlaying, currentIsVideo, isUserPaused]);

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
      // Don't hijack keys while a form control has focus or a chord is held
      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

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
        case 'f':
          showCurrentInFinder();
          break;
        case 'g':
          setIsGridOpen(prev => !prev);
          break;
        case 'h':
          toggleFavorite();
          break;
        case 't':
          setIsTagEditorOpen(prev => !prev);
          break;
        case 'm':
          seekVideoBy(10);
          break;
        case 'n':
          seekVideoBy(-10);
          break;
        case '1':
        case '2':
        case '3':
          quickMove(parseInt(e.key) - 1);
          break;
        case 'Escape':
          setIsTagEditorOpen(false);
          setIsGridOpen(false);
          setIsSettingsOpen(false);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide, togglePlay, deleteCurrentFile, showCurrentInFinder, seekVideoBy, quickMove, toggleFavorite]);

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
    // Items in the Actions menu mirror the keyboard shortcuts
    const actions: Record<string, () => void> = {
      'next': nextSlide,
      'prev': prevSlide,
      'toggle-play': togglePlay,
      'grid': () => setIsGridOpen(prev => !prev),
      'favorite': toggleFavorite,
      'tags': () => setIsTagEditorOpen(prev => !prev),
      'seek-forward': () => seekVideoBy(10),
      'seek-back': () => seekVideoBy(-10),
      'reveal': showCurrentInFinder,
      'delete': deleteCurrentFile,
    };
    const cleanups = [
      window.api.on('menu:open-directory', () => handleOpenDirectory()),
      window.api.on('menu:show-in-finder', () => showCurrentInFinder()),
      window.api.on('menu:open-settings', () => setIsSettingsOpen(true)),
      window.api.on('menu:action', (_event, name: string) => actions[name]?.()),
    ];
    return () => cleanups.forEach(c => c());
  }, [handleOpenDirectory, showCurrentInFinder, nextSlide, prevSlide, togglePlay, seekVideoBy, deleteCurrentFile, toggleFavorite]);

  const currentFile: MediaFile | null = files.length > 0 ? files[currentIndex] : null;
  const fileUrl = currentFile ? getFileUrl(currentFile.path) : '';
  const currentTransition = slideTransitions[transitionStyle];

  // Settings, dedupe, and toasts are available in both states — you can
  // configure the slideshow or hunt duplicates before opening a folder.
  return (
    <div className="app-container">
      <SettingsMenu
        isOpen={isSettingsOpen}
        onClose={toggleSettings}
        hasFiles={currentFile !== null}
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
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
        slideDuration={slideDuration}
        onDurationChange={setSlideDuration}
        controlsPosition={controlsPosition}
        onControlsPositionChange={setControlsPosition}
        quickMoveFolders={quickMoveFolders}
        onSetQuickMoveFolder={(slot, path) => {
          const next = [...quickMoveFolders];
          next[slot] = path;
          setQuickMoveFolders(next);
        }}
        showSlideTimer={showSlideTimer}
        onToggleSlideTimer={() => setShowSlideTimer(!showSlideTimer)}
        favoritesOnly={favoritesOnly}
        onToggleFavoritesOnly={() => setFavoritesOnly(prev => !prev)}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        tagNames={tagNames}
        onShowInFinder={() => {
          showCurrentInFinder();
          toggleSettings();
        }}
        onFindDuplicates={() => {
          setIsSettingsOpen(false);
          setIsDedupeOpen(true);
        }}
      />

      {currentFile === null ? (
        <>
          <div className="title-bar">photo-slap</div>
          <IntroScreen
            isLoading={isLoading}
            onOpenDirectory={handleOpenDirectory}
            lastDirName={lastDirs[0]?.split(/[/\\]/).pop() ?? null}
            onResume={handleResume}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onFindDuplicates={() => setIsDedupeOpen(true)}
          />
        </>
      ) : (
        <>
      {/* Title Bar with Filename */}
      <div className={`title-bar ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`}>
        {currentFile.name}
      </div>

      <div className={`file-info ${showControls ? 'visible' : ''} ${controlsPosition === 'left' ? 'position-left' : ''}`} style={controlsPosition === 'left' ? {} : { top: '50px' }}>
        {currentIndex + 1} / {files.length}
      </div>

      {favorites.has(currentFile.path) && (
        <div className="fav-indicator" title="Favorite (H to toggle)">
          <FiHeart />
        </div>
      )}

      {showSlideTimer && isPlaying && currentFile.type === 'image' && (
        <div
          className="slide-timer"
          key={`${currentIndex}-${slideDuration}`}
          style={{ animationDuration: `${slideDuration}ms` }}
        />
      )}

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
        {/* "sync" keeps the old slide mounted underneath while the star wipes in over it.
            `custom` carries the nav direction so exiting slides mirror correctly too. */}
        <AnimatePresence mode={transitionStyle === 'star' ? 'sync' : 'wait'} custom={direction}>
          <motion.div
            key={currentFile.path}
            custom={direction}
            variants={currentTransition.variants}
            initial="enter"
            animate="center"
            exit="exit"
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
                    loop
                    // no autoPlay: playback is owned by the sync effect so
                    // the blur pauses and seeks together with the main video
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
              <ZoomPan resetKey={currentFile.path} onZoomChange={setIsZoomed}>
                <img
                  src={fileUrl}
                  className={`media-element ${isKenBurns && !isZoomed ? `ken-burns-active ${kenBurnsClass}` : ''}`}
                  alt={currentFile.name}
                  style={{
                    objectFit: isStretch ? 'contain' : (isKenBurns ? 'cover' : 'contain'),
                    width: isStretch || isKenBurns ? '100%' : 'auto',
                    height: isStretch || isKenBurns ? '100%' : 'auto',
                    maxWidth: isStretch ? '100%' : (isKenBurns ? 'none' : '100%'),
                    maxHeight: isStretch ? '100%' : (isKenBurns ? 'none' : '100%')
                  }}
                />
              </ZoomPan>
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

          <button className={`control-btn ${isGridOpen ? 'active' : ''}`} onClick={() => setIsGridOpen(prev => !prev)} title="Grid View (G)">
            <FiGrid size={20} />
          </button>

          <button className={`control-btn ${isSettingsOpen ? 'active' : ''}`} onClick={toggleSettings} title="Settings">
            <FiSettings size={20} />
          </button>

          <button className="control-btn danger" onClick={deleteCurrentFile} title="Delete (Del/Backspace)">
            <FiTrash2 size={20} />
          </button>
        </div>
      </div>

      {isGridOpen && (
        <GridView
          files={files}
          currentIndex={currentIndex}
          favorites={favorites}
          onSelect={(i) => {
            setDirection(i >= currentIndex ? 1 : -1);
            setCurrentIndex(i);
            setIsGridOpen(false);
          }}
          onClose={() => setIsGridOpen(false)}
        />
      )}

      {isTagEditorOpen && (
        <TagEditor
          fileName={currentFile.name}
          fileTags={fileTags[currentFile.path] ?? []}
          tagNames={tagNames}
          onToggleTag={(tag) => setTagOnCurrent(tag)}
          onAddTag={(tag) => setTagOnCurrent(tag, true)}
          onClose={() => setIsTagEditorOpen(false)}
        />
      )}
        </>
      )}

      <DedupeModal
        isOpen={isDedupeOpen}
        onClose={() => setIsDedupeOpen(false)}
        rootPaths={currentDirs}
        onFilesDeleted={handleFilesDeleted}
      />

      <Toast message={toast} />
    </div>
  )
}

export default App

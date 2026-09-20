import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { FiSettings, FiPlay, FiPause, FiSkipBack, FiSkipForward, FiTrash2, FiVolume2, FiVolumeX, FiGrid, FiHeart, FiCheck, FiFolder, FiX } from 'react-icons/fi'
import './App.css'
import { DedupeModal } from './components/DedupeModal'
import { FrameOverlay } from './components/FrameOverlay'
import { GridView } from './components/GridView'
import { IntroScreen } from './components/IntroScreen'
import { LibraryHealthModal } from './components/LibraryHealthModal'
import { TagEditor } from './components/TagEditor'
import { SettingsMenu, MediaFilter, ControlsPosition, SortOrder } from './components/SettingsMenu'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { Toast, ToastAction } from './components/Toast'
import { ZoomPan } from './components/ZoomPan'
import { useAmbientColor } from './hooks/useAmbientColor'
import { useImagePreloader } from './hooks/useImagePreloader'
import { useLibraryMeta } from './hooks/useLibraryMeta'
import { usePendingDeletes, UNDO_WINDOW_MS } from './hooks/usePendingDeletes'
import { useRemote } from './hooks/useRemote'
import { useSlideshowPlayback } from './hooks/useSlideshowPlayback'
import { usePersistedState } from './hooks/usePersistedState'
import { clampIndex, survivingNeighbourPath } from './playlist'
import {
  slideTransitions, presenceModeFor, resolveTransition,
  type ConcreteTransitionStyle, type TransitionStyle,
} from './transitions'
import { getFileUrl, getDisplayUrl } from './utils'
import { cullingActionForKey } from './culling'
import { SETTINGS_PRESETS, type SettingsPresetName } from './settingsPresets'
import { getShuffleProgress, makeShuffleHistoryKey, orderForNoRepeatShuffle, recordViewed, type ShuffleHistory } from './shuffleHistory'
import { healthIssuesByPath } from './gridFilters'

const mergeScans = (results: ScanResult[]): ScanResult => ({
  paths: results.flatMap(r => r.paths),
  files: results.flatMap(r => r.files),
  errors: results.flatMap(r => r.errors),
})

// A reused Collator is ~20x faster than per-call localeCompare(…, options),
// which matters when sorting libraries with tens of thousands of files.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Viewed-history disk writes are coalesced over this window. */
const SHUFFLE_HISTORY_WRITE_DEBOUNCE_MS = 5000;

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
  const [isHealthOpen, setIsHealthOpen] = useState(false)
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false)
  const [healthRoots, setHealthRoots] = useState<string[]>([])

  const [healthReport, setHealthReport] = useState<LibraryHealthReport | null>(null)
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
  // Fills the letterbox with the photo's own average colour. Mutually
  // exclusive with the blurred smart background, which fills the same space.
  const [isAmbientColor, setIsAmbientColor] = usePersistedState('isAmbientColor', false)
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
  const [frameMode, setFrameMode] = usePersistedState('frameMode', false)
  const [autoPlayOnOpen, setAutoPlayOnOpen] = usePersistedState('autoPlayOnOpen', false)
  const [remoteEnabled, setRemoteEnabled] = usePersistedState('remoteEnabled', false)
  const [cullingMode, setCullingMode] = usePersistedState('cullingMode', false)

  // Shuffle history is keyed by library roots + media filter. It deliberately
  // lives in app storage (not the library sidecar) so viewed state survives an
  // app restart without modifying the user's photo folders.
  const shuffleHistoryRef = useRef<ShuffleHistory>({})
  const [shuffleHistoryReady, setShuffleHistoryReady] = useState(false)
  const [shuffleProgress, setShuffleProgress] = useState({ viewed: 0, total: 0 })
  useEffect(() => {
    window.api.getStore('shuffleHistory')
      .then(value => { if (value && typeof value === 'object') shuffleHistoryRef.current = value as ShuffleHistory; })
      .finally(() => setShuffleHistoryReady(true));
  }, []);

  /**
   * Record the history in memory immediately, but write it to disk on a
   * debounce. Every slide adds one path, and writing on each of them meant
   * serialising the whole (library-sized) viewed list to electron-store every
   * few seconds — for a photo frame left running, that is constant disk churn
   * for data only read at startup.
   */
  const shuffleWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushShuffleHistory = useCallback(() => {
    if (!shuffleWriteTimer.current) return;
    clearTimeout(shuffleWriteTimer.current);
    shuffleWriteTimer.current = null;
    window.api.setStore('shuffleHistory', shuffleHistoryRef.current);
  }, []);

  const persistShuffleHistory = useCallback((history: ShuffleHistory) => {
    shuffleHistoryRef.current = history;
    if (shuffleWriteTimer.current) clearTimeout(shuffleWriteTimer.current);
    shuffleWriteTimer.current = setTimeout(() => {
      shuffleWriteTimer.current = null;
      window.api.setStore('shuffleHistory', shuffleHistoryRef.current);
    }, SHUFFLE_HISTORY_WRITE_DEBOUNCE_MS);
  }, []);

  // Don't lose the tail of a session on quit or reload
  useEffect(() => {
    window.addEventListener('beforeunload', flushShuffleHistory);
    return () => {
      window.removeEventListener('beforeunload', flushShuffleHistory);
      flushShuffleHistory();
    };
  }, [flushShuffleHistory]);

  /**
   * The style the next slide change will actually use. With `random` this is
   * re-rolled per slide; with a fixed style it just tracks the setting.
   *
   * It is chosen for the *next* change rather than the current one on purpose:
   * framer-motion reads `variants` when the incoming slide mounts, so the
   * value has to be settled before the key changes. Picking it here — after a
   * slide has landed — means it always is, and AnimatePresence's `mode` never
   * flips in the same render as the key.
   */
  const [activeTransition, setActiveTransition] = useState<ConcreteTransitionStyle>('fade')

  // Zoom state (per-slide; ZoomPan reports in so Ken Burns can pause)
  const [isZoomed, setIsZoomed] = useState(false)

  // Last opened folder(s), for the intro screen's Resume button
  const [lastDirs, setLastDirs] = useState<string[]>([])
  useEffect(() => {
    window.api.getStore('lastDirs')
      .then(v => { if (Array.isArray(v) && v.length > 0) setLastDirs(v); })
      .catch(() => { });
  }, []);

  // Toast — optionally with a single action button (used by undo)
  const [toast, setToast] = useState<string | null>(null)
  const [toastAction, setToastAction] = useState<ToastAction | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // While a toast carries an action, that toast is the only way to reach it.
  // A passing status message ("Skipping X — it won't play") must not replace
  // it and silently take Undo away mid-window.
  const actionToastUntilRef = useRef(0);
  const showToast = useCallback((message: string, action: ToastAction | null = null, durationMs = 4000) => {
    if (!action && Date.now() < actionToastUntilRef.current) return;
    actionToastUntilRef.current = action ? Date.now() + durationMs : 0;
    setToast(message);
    setToastAction(action);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      actionToastUntilRef.current = 0;
      setToast(null);
      setToastAction(null);
    }, durationMs);
  }, []);
  const dismissToast = useCallback(() => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    actionToastUntilRef.current = 0;
    setToast(null);
    setToastAction(null);
  }, []);

  // Set by Resume so the slideshow reopens at the slide it was left on
  const pendingIndexRef = useRef<number | null>(null);
  // Set when the list is about to be re-derived but the slideshow should land
  // on a specific file (the survivor of a delete, a guest upload, …)
  const pendingPathRef = useRef<string | null>(null);

  /** Index to land on for a freshly derived list, consuming any pin. */
  const takePendingIndex = useCallback((list: MediaFile[]) => {
    if (pendingPathRef.current !== null) {
      const idx = list.findIndex(f => f.path === pendingPathRef.current);
      pendingPathRef.current = null;
      if (idx >= 0) return idx;
    }
    if (pendingIndexRef.current !== null) {
      const idx = clampIndex(pendingIndexRef.current, list.length);
      pendingIndexRef.current = null;
      return idx;
    }
    return 0;
  }, []);

  const applyFiltersAndSort = useCallback((
    unfiltered: MediaFile[],
    currentFilter: string,
    isShuffled: boolean,
    sort: SortOrder,
    dates: Record<string, number> | null,
    shuffleKey: string,
  ) => {
    let filtered = unfiltered;
    if (currentFilter === 'photos') {
      filtered = unfiltered.filter(f => f.type === 'image');
    } else if (currentFilter === 'videos') {
      filtered = unfiltered.filter(f => f.type === 'video');
    }

    // Natural name sort first — it's also the tiebreaker for equal dates
    const sorted = [...filtered].sort((a, b) => nameCollator.compare(a.name, b.name));

    if (sort !== 'name' && dates) {
      sorted.sort((a, b) => {
        const da = dates[a.path] ?? 0;
        const db = dates[b.path] ?? 0;
        return sort === 'date-desc' ? db - da : da - db;
      });
    }

    if (isShuffled) {
      const previousHistory = shuffleHistoryRef.current[shuffleKey] ?? [];
      const ordered = orderForNoRepeatShuffle(sorted, previousHistory);
      sorted.splice(0, sorted.length, ...ordered.items);
      setShuffleProgress(getShuffleProgress(sorted, ordered.viewedPaths));
      if (ordered.cycleReset || ordered.viewedPaths.length !== previousHistory.length) {
        persistShuffleHistory({ ...shuffleHistoryRef.current, [shuffleKey]: ordered.viewedPaths });
      }
    } else {
      setShuffleProgress({ viewed: 0, total: sorted.length });
    }

    setFiles(sorted);
    // Resume on the pinned slide when one is queued (a delete, a quick-move,
    // a guest upload, Resume). Consuming the pin *here* matters: this is the
    // one place that would otherwise force index 0, and the effect that used
    // to restore the pin ran on an earlier render, so the reset always won.
    setCurrentIndex(takePendingIndex(sorted));
  }, [persistShuffleHistory, takePendingIndex]);

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

  const ingestScanResult = useCallback((result: ScanResult) => {
    if (result.errors.length > 0) {
      showToast(`${result.errors.length} folder${result.errors.length > 1 ? 's' : ''} couldn't be read`);
    }

    if (result.files.length > 0) {
      setCurrentDirs(result.paths);
      setHealthReport(null);
      fileDatesRef.current = null;
      setAllFiles(result.files); // the filter/sort effect below picks this up
      setIsPlaying(autoPlayOnOpen); // photo-frame setups want the show to start immediately
      window.api.setStore('lastDirs', result.paths);
      setLastDirs(result.paths);
    } else {
      showToast('No media files found in that folder');
    }
  }, [showToast, autoPlayOnOpen]);

  // Self-heal an index left past the end of a list that shrank. It used to
  // mean `files[currentIndex]` was undefined, which both killed the advance
  // timer (a permanent freeze) and threw while rendering the slide.
  useEffect(() => {
    if (files.length > 0 && currentIndex > files.length - 1) {
      setCurrentIndex(files.length - 1);
    }
  }, [files, currentIndex]);

  // Fallback for lists set outside applyFiltersAndSort (which consumes the
  // pin itself). A no-op when it already did.
  useEffect(() => {
    if (files.length === 0) return;
    if (pendingPathRef.current === null && pendingIndexRef.current === null) return;
    setCurrentIndex(takePendingIndex(files));
  }, [files, takePendingIndex]);

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

  // Favorites, tags, ratings and culling decisions (sidecar-backed)
  const meta = useLibraryMeta(currentDirs);
  const { favorites, fileTags, tagNames, ratings, cullingDecisions } = meta;

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
    if (allFiles.length === 0) {
      // Deleting the last file used to leave it on screen: the derive bailed
      // out here and `files` kept the stale list.
      setFiles([]);
      setCurrentIndex(0);
      return;
    }
    if (isShuffle && !shuffleHistoryReady) return;
    let cancelled = false;
    (async () => {
      let source = allFiles;
      if (favoritesOnly) source = source.filter(f => favoritesRef.current.has(f.path));
      if (tagFilter) source = source.filter(f => fileTagsRef.current[f.path]?.includes(tagFilter));
      if (source.length === 0) {
        showToast(favoritesOnly || tagFilter ? 'No files match the filters' : 'No media files');
      }
      const dates = sortOrder !== 'name' ? await ensureDates(allFiles) : null;
      const shuffleKey = makeShuffleHistoryKey(currentDirs, mediaFilter);
      if (!cancelled) applyFiltersAndSort(source, mediaFilter, isShuffle, sortOrder, dates, shuffleKey);
    })();
    return () => { cancelled = true; };
  }, [allFiles, mediaFilter, isShuffle, sortOrder, favoritesOnly, tagFilter, currentDirs, shuffleHistoryReady, ensureDates, applyFiltersAndSort, showToast]);

  // Viewing a slide records it immediately, so closing the app cannot make
  // the next launch start repeating already-seen media.
  useEffect(() => {
    const file = files[currentIndex];
    if (!isShuffle || !shuffleHistoryReady || !file || currentDirs.length === 0) return;
    const key = makeShuffleHistoryKey(currentDirs, mediaFilter);
    const next = recordViewed(shuffleHistoryRef.current, key, file.path);
    if (next !== shuffleHistoryRef.current) persistShuffleHistory(next);
    setShuffleProgress(getShuffleProgress(files, next[key] ?? []));
  }, [files, currentIndex, isShuffle, shuffleHistoryReady, currentDirs, mediaFilter, persistShuffleHistory]);

  const toggleFavorite = useCallback(() => {
    const file = files[currentIndex];
    if (!file) return;
    const nowFavorite = meta.toggleFavoriteAt(file.path);
    // Un-favoriting while the favorites filter is on removes it from view
    if (!nowFavorite && favoritesOnly) {
      const remaining = files.filter(f => f.path !== file.path);
      setFiles(remaining);
      setCurrentIndex(ci => clampIndex(ci, remaining.length));
    }
  }, [files, currentIndex, favoritesOnly, meta]);

  const setTagOnCurrent = useCallback((tag: string, ensureInVocabulary = false) => {
    const file = files[currentIndex];
    if (!file) return;
    meta.setTag(file.path, tag, ensureInVocabulary);
  }, [files, currentIndex, meta]);

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

  /**
   * Slides guests have queued from their phones, as paths. A queued slide
   * jumps the line on the next advance — automatic or manual — which is the
   * whole point: someone picks a photo and it comes up next.
   */
  const queueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

  /** Pop the next queued slide's index, skipping any that have since gone. */
  const takeQueuedIndex = useCallback((list: MediaFile[]) => {
    let found: number | null = null;
    while (queueRef.current.length > 0 && found === null) {
      const [path, ...rest] = queueRef.current;
      queueRef.current = rest;
      const index = list.findIndex(file => file.path === path);
      if (index >= 0) found = index;
    }
    setQueuedCount(queueRef.current.length);
    return found;
  }, []);

  useEffect(() => {
    return window.api.on('remote:queue', (_event, index: number) => {
      const file = files[index];
      if (!file) return;
      queueRef.current = [...queueRef.current, file.path];
      setQueuedCount(queueRef.current.length);
      showToast(`\u{1F4FA} ${file.name} — queued by a guest`);
    });
  }, [files, showToast]);

  // NOTE: keep these updaters pure (no setState inside another setState
  // updater) — StrictMode double-invokes updaters and impure ones make
  // navigation skip slides in dev.
  const nextSlide = useCallback(() => {
    setDirection(1);
    if (files.length === 0) return;
    // Guest picks come first, ahead of shuffle and normal order alike.
    const queued = takeQueuedIndex(files);
    if (queued !== null) {
      setCurrentIndex(queued);
      return;
    }
    if (isShuffle && currentIndex === files.length - 1) {
      const key = makeShuffleHistoryKey(currentDirs, mediaFilter);
      persistShuffleHistory({ ...shuffleHistoryRef.current, [key]: [] });
      setShuffleProgress({ viewed: 0, total: files.length });
      setFiles(orderForNoRepeatShuffle(files, []).items);
      setCurrentIndex(0);
      return;
    }
    setCurrentIndex(prev => (prev + 1) % files.length);
  }, [files, currentIndex, isShuffle, currentDirs, mediaFilter, persistShuffleHistory, takeQueuedIndex]);

  const prevSlide = useCallback(() => {
    setDirection(-1);
    setCurrentIndex(prev => files.length === 0 ? prev : (prev - 1 + files.length) % files.length);
  }, [files.length]);

  const togglePlay = useCallback(() => {
    if (!cullingMode) setIsPlaying(prev => !prev);
  }, [cullingMode]);

  // List-shaping settings just persist; the effect above re-derives the list
  const toggleShuffle = () => setIsShuffle(!isShuffle);
  const resetShuffleHistory = useCallback(() => {
    if (currentDirs.length === 0) return;
    const key = makeShuffleHistoryKey(currentDirs, mediaFilter);
    persistShuffleHistory({ ...shuffleHistoryRef.current, [key]: [] });
    setShuffleProgress({ viewed: 0, total: files.length });
    if (isShuffle) {
      setFiles(orderForNoRepeatShuffle(files, []).items);
      setCurrentIndex(0);
    }
    showToast('Shuffle history reset');
  }, [currentDirs, mediaFilter, files, isShuffle, persistShuffleHistory, showToast]);
  const handleMediaFilterChange = (newFilter: MediaFilter) => setMediaFilter(newFilter);

  useEffect(() => {
    if (cullingMode) setIsPlaying(false);
  }, [cullingMode]);

  const applyPreset = useCallback((name: SettingsPresetName) => {
    const preset = SETTINGS_PRESETS[name];
    setMediaFilter(preset.mediaFilter);
    setIsShuffle(preset.isShuffle);
    setIsSmart(preset.isSmart);
    setIsSmartVideoEnabled(preset.isSmartVideoEnabled);
    setIsAmbientColor(preset.isAmbientColor);
    setIsStretch(preset.isStretch);
    setIsKenBurns(preset.isKenBurns);
    setIsExifEnabled(preset.isExifEnabled);
    setTransitionStyle(preset.transitionStyle);
    setSortOrder(preset.sortOrder);
    setSlideDuration(preset.slideDuration);
    setControlsPosition(preset.controlsPosition);
    setShowSlideTimer(preset.showSlideTimer);
    setFrameMode(preset.frameMode);
    setAutoPlayOnOpen(preset.autoPlayOnOpen);
    setRemoteEnabled(preset.remoteEnabled);
    setCullingMode(preset.cullingMode);
    if (preset.cullingMode) setIsPlaying(false);
    showToast(`${name} preset applied`);
  }, [setMediaFilter, setIsShuffle, setIsSmart, setIsSmartVideoEnabled, setIsAmbientColor, setIsStretch, setIsKenBurns, setIsExifEnabled, setTransitionStyle, setSortOrder, setSlideDuration, setControlsPosition, setShowSlideTimer, setFrameMode, setAutoPlayOnOpen, setRemoteEnabled, setCullingMode, showToast]);

  const openHealthScan = useCallback(async () => {
    let roots = currentDirs;
    if (roots.length === 0) {
      const picked = await window.api.pickDirectory();
      if (!picked) return;
      roots = [picked];
    }
    setHealthRoots(roots);
    setIsSettingsOpen(false);
    setIsGridOpen(false);
    setIsHealthOpen(true);
  }, [currentDirs]);

  /**
   * Pin the nearest surviving slide before a removal. Changing `allFiles`
   * re-derives the playable list, and that derive resets the index to 0 — so
   * without this every delete threw the user back to the first photo.
   */
  const pinSurvivingNeighbour = useCallback((removedPaths: string[]) => {
    pendingPathRef.current = survivingNeighbourPath(files, currentIndex, new Set(removedPaths));
  }, [files, currentIndex]);

  /**
   * Take files out of the slideshow without touching disk. Only `allFiles` is
   * touched: the derive effect is the single owner of the playable list, and
   * setting `files` here too would race it (and would consume the pin on an
   * earlier render than the derive's own reset).
   */
  const removeFromView = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const gone = new Set(paths);
    pinSurvivingNeighbour(paths);
    setAllFiles(prev => prev.filter(f => !gone.has(f.path)));
  }, [pinSurvivingNeighbour]);

  /** Put files back after an undo, or after a trash that failed. */
  const restoreToView = useCallback((restored: MediaFile[]) => {
    if (restored.length === 0) return;
    pendingPathRef.current = restored[0].path;
    setAllFiles(prev => {
      const known = new Set(prev.map(f => f.path));
      const missing = restored.filter(f => !known.has(f.path));
      return missing.length === 0 ? prev : [...prev, ...missing];
    });
  }, []);

  const { pending: pendingDelete, requestDelete, undo: undoDelete } = usePendingDeletes({
    onRemoved: files => removeFromView(files.map(f => f.path)),
    onRestored: restoreToView,
  });

  // Deleting also forgets the files' sidecar metadata, so favorites and tags
  // for paths that no longer exist don't accumulate into orphan entries.
  useEffect(() => {
    if (pendingDelete) meta.forget(pendingDelete.map(f => f.path));
  }, [pendingDelete, meta]);

  const undoDeleteAndDismiss = useCallback(() => {
    undoDelete();
    dismissToast();
    showToast('Delete undone');
  }, [undoDelete, dismissToast, showToast]);

  const deleteFiles = useCallback((toDelete: MediaFile[]) => {
    if (toDelete.length === 0) return;
    requestDelete(toDelete);
    const label = toDelete.length === 1
      ? `Deleted ${toDelete[0].name}`
      : `Deleted ${toDelete.length} files`;
    showToast(label, { label: 'Undo', onAction: undoDeleteAndDismiss }, UNDO_WINDOW_MS);
  }, [requestDelete, showToast, undoDeleteAndDismiss]);

  const deleteCurrentFile = useCallback(() => {
    const file = files[currentIndex];
    if (file) deleteFiles([file]);
  }, [files, currentIndex, deleteFiles]);

  // Dedupe and health repairs move files out from under us: drop them from
  // the slideshow and forget their metadata too.
  const handleFilesDeleted = useCallback((deleted: string[]) => {
    removeFromView(deleted);
    meta.forget(deleted);
  }, [removeFromView, meta]);

  const handleMetadataRemoved = useCallback((removed: string[]) => {
    meta.forgetLocally(removed); // the repair already rewrote the sidecars
  }, [meta]);

  const handleFilesRestored = useCallback(async (restored: string[]) => {
    if (restored.length === 0 || currentDirs.length === 0) return;
    pendingPathRef.current = files[currentIndex]?.path ?? null;
    const results = await Promise.all(currentDirs.map(dir => window.api.scanPath(dir)));
    const valid = results.filter((result): result is ScanResult => result !== null);
    if (valid.length > 0) {
      fileDatesRef.current = null;
      setAllFiles(mergeScans(valid).files);
      showToast(`${restored.length} file${restored.length === 1 ? '' : 's'} restored and re-scanned`);
    }
  }, [currentDirs, files, currentIndex, showToast]);

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

  useEffect(() => {
    const next = resolveTransition(transitionStyle, activeTransition);
    if (next !== activeTransition) setActiveTransition(next);
    // activeTransition is deliberately not a dependency: including it would
    // re-run this on its own update and re-roll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionStyle, currentIndex]);

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
    notePlaybackProgress(); // tells the stall watchdog the video is alive
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

  // Batch operations from the grid's select mode
  const batchFavorite = meta.setFavorite;
  const batchTag = meta.addTagToAll;
  const batchRating = meta.setRating;
  const batchCulling = meta.setCulling;

  const markCurrentCulling = useCallback((decision: CullingDecision) => {
    const file = files[currentIndex];
    if (!file) return;
    meta.setCulling([file.path], decision);
    nextSlide();
  }, [files, currentIndex, meta, nextSlide]);

  const batchDelete = useCallback((paths: string[]) => {
    const known = new Map(files.map(f => [f.path, f]));
    const toDelete = paths.map(p => known.get(p)).filter((f): f is MediaFile => f !== undefined);
    deleteFiles(toDelete);
  }, [files, deleteFiles]);

  const batchMove = useCallback(async (paths: string[], slot: number) => {
    const destDir = quickMoveFolders[slot];
    if (!destDir) return;
    const moved: string[] = [];
    for (const p of paths) {
      const result = await window.api.moveFile(p, destDir);
      if (result.ok) moved.push(p);
    }
    if (moved.length > 0) {
      handleFilesDeleted(moved);
      showToast(`Moved ${moved.length} to ${destDir.split(/[/\\]/).pop()}`);
    }
    if (moved.length < paths.length) {
      showToast(`${paths.length - moved.length} file(s) could not be moved`);
    }
  }, [quickMoveFolders, handleFilesDeleted, showToast]);

  // Photo-frame overlay: fetch the current photo's date-taken lazily.
  // The "already fetched" set is a ref so adding an entry doesn't re-run the
  // effect that added it.
  const [frameDates, setFrameDates] = useState<Record<string, number>>({});
  const frameDatesFetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    const file = files[currentIndex];
    if (!frameMode || !file || frameDatesFetched.current.has(file.path)) return;
    frameDatesFetched.current.add(file.path);
    window.api.getDates([file.path]).then(dates => {
      setFrameDates(prev => ({ ...prev, [file.path]: dates[file.path] ?? 0 }));
    });
  }, [frameMode, files, currentIndex]);

  // Phone remote, party reactions, guest uploads and the join QR code
  const handleGuestUpload = useCallback((file: MediaFile) => {
    // Keep the current slide in place; the re-derive would otherwise reset it
    pendingPathRef.current = files[currentIndex]?.path ?? null;
    setAllFiles(prev => prev.some(f => f.path === file.path) ? prev : [...prev, file]);
    showToast(`\u{1F4F8} ${file.name} joined the show`);
  }, [files, currentIndex, showToast]);

  const currentFile: MediaFile | null = files[currentIndex] ?? null;

  const ambientColor = useAmbientColor(currentFile, isAmbientColor && !isSmart);

  const { url: remoteUrl, qr: remoteQr, reactions } = useRemote({
    enabled: remoteEnabled,
    currentFile,
    currentIndex,
    total: files.length,
    isPlaying,
    isFavorite: currentFile ? favorites.has(currentFile.path) : false,
    queued: queuedCount,
    library: files,
    root: currentDirs[0] ?? null,
    onUploaded: handleGuestUpload,
  });

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

  useImagePreloader(files, currentIndex);

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

  // Slideshow advance: image timer + the watchdog for videos whose `ended`
  // event never arrives (see useSlideshowPlayback).
  const handleStalledVideo = useCallback((file: MediaFile) => {
    showToast(`Skipping ${file.name} — it won't play`);
  }, [showToast]);

  const { notePlaybackProgress } = useSlideshowPlayback({
    isPlaying,
    currentFile: files[currentIndex] ?? null,
    isUserPaused,
    slideDuration,
    onAdvance: nextSlide,
    onStalled: handleStalledVideo,
  });

  /**
   * A video that cannot be decoded at all (unsupported codec, truncated file,
   * or one deleted from disk while queued) fires `error` and never `ended`.
   * Move on rather than parking the slideshow on it.
   */
  const handleVideoError = useCallback(() => {
    const file = files[currentIndex];
    showToast(file ? `Can't play ${file.name} — skipping` : "Can't play that video");
    if (isPlaying) nextSlide();
  }, [files, currentIndex, isPlaying, nextSlide, showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't hijack keys while a form control has focus or a chord is held
      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (cullingMode) {
        const action = cullingActionForKey(e.key);
        if (action === 'keep') {
          e.preventDefault();
          markCurrentCulling('keep');
          return;
        }
        if (action === 'reject') {
          e.preventDefault();
          markCurrentCulling('reject');
          return;
        }
      }

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
        case '?':
          setIsShortcutsOpen(prev => !prev);
          break;
        case 'h':
          toggleFavorite();
          break;
        case 'p':
          setFrameMode(!frameMode);
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
          setIsHealthOpen(false);
          setIsShortcutsOpen(false);
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide, togglePlay, deleteCurrentFile, showCurrentInFinder, seekVideoBy, quickMove, toggleFavorite, frameMode, setFrameMode, cullingMode, markCurrentCulling]);

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
      'frame': () => setFrameMode(!frameMode),
      'favorite': toggleFavorite,
      'tags': () => setIsTagEditorOpen(prev => !prev),
      'seek-forward': () => seekVideoBy(10),
      'seek-back': () => seekVideoBy(-10),
      'reveal': showCurrentInFinder,
      'delete': deleteCurrentFile,
      // Non-destructive, matching the K/X keys. 'delete' above is the only
      // menu action that trashes anything.
      'culling-keep': () => markCurrentCulling('keep'),
      'culling-reject': () => markCurrentCulling('reject'),
      'shortcuts': () => setIsShortcutsOpen(prev => !prev),
    };
    const cleanups = [
      window.api.on('menu:open-directory', () => handleOpenDirectory()),
      window.api.on('menu:show-in-finder', () => showCurrentInFinder()),
      window.api.on('menu:open-settings', () => setIsSettingsOpen(true)),
      window.api.on('menu:action', (_event, name: string) => actions[name]?.()),
    ];
    return () => cleanups.forEach(c => c());
  }, [handleOpenDirectory, showCurrentInFinder, nextSlide, prevSlide, togglePlay, seekVideoBy, deleteCurrentFile, toggleFavorite, frameMode, setFrameMode, markCurrentCulling]);

  const fileUrl = currentFile ? getFileUrl(currentFile.path) : '';
  const currentTransition = slideTransitions[activeTransition];
  const healthIssues = useMemo(() => healthIssuesByPath(healthReport), [healthReport]);

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
        shuffleProgress={shuffleProgress}
        onResetShuffle={resetShuffleHistory}
        isSmart={isSmart}
        onToggleSmart={() => setIsSmart(!isSmart)}
        isAmbientColor={isAmbientColor}
        onToggleAmbientColor={() => setIsAmbientColor(!isAmbientColor)}
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
        frameMode={frameMode}
        onToggleFrameMode={() => setFrameMode(!frameMode)}
        autoPlayOnOpen={autoPlayOnOpen}
        onToggleAutoPlayOnOpen={() => setAutoPlayOnOpen(!autoPlayOnOpen)}
        remoteEnabled={remoteEnabled}
        onToggleRemote={() => setRemoteEnabled(!remoteEnabled)}
        remoteUrl={remoteUrl}
        remoteQr={remoteQr}
        favoritesOnly={favoritesOnly}
        onToggleFavoritesOnly={() => setFavoritesOnly(prev => !prev)}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        tagNames={tagNames}
        cullingMode={cullingMode}
        onToggleCullingMode={() => {
          const next = !cullingMode;
          setCullingMode(next);
          if (next) {
            setMediaFilter('photos');
            setIsPlaying(false);
          }
        }}
        onApplyPreset={applyPreset}
        onShowInFinder={() => {
          showCurrentInFinder();
          toggleSettings();
        }}
        onFindDuplicates={() => {
          setIsSettingsOpen(false);
          setIsDedupeOpen(true);
        }}
        onScanHealth={openHealthScan}
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
            onScanHealth={openHealthScan}
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
        {isShuffle && <span className="shuffle-cycle-label"> · cycle {shuffleProgress.viewed}/{shuffleProgress.total}</span>}
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

      {cullingMode && (
        <div className="culling-bar" aria-label="Photo culling controls">
          <div className="culling-title"><strong>CULLING</strong><span>{currentIndex + 1} of {files.length}</span></div>
          <button className={`culling-action keep ${cullingDecisions[currentFile.path] === 'keep' ? 'active' : ''}`} onClick={() => markCurrentCulling('keep')}><FiCheck /> Keep & Next <kbd>K</kbd></button>
          <button className={`culling-action ${favorites.has(currentFile.path) ? 'active' : ''}`} onClick={toggleFavorite}><FiHeart /> Favorite <kbd>H</kbd></button>
          <div className="culling-rating" aria-label="Star rating">
            {[1, 2, 3, 4, 5].map(rating => (
              <button key={rating} className={ratings[currentFile.path] === rating ? 'active' : ''} onClick={() => batchRating([currentFile.path], ratings[currentFile.path] === rating ? null : rating)} aria-label={`${rating} star rating`}>★</button>
            ))}
          </div>
          {quickMoveFolders.map((folder, i) => folder && (
            <button key={i} className="culling-action" onClick={() => quickMove(i)} title={folder}><FiFolder /> Move <kbd>{i + 1}</kbd></button>
          ))}
          <button className={`culling-action reject ${cullingDecisions[currentFile.path] === 'reject' ? 'active' : ''}`} onClick={() => markCurrentCulling('reject')}><FiX /> Reject & Next <kbd>X</kbd></button>
        </div>
      )}

      {frameMode && (
        <FrameOverlay
          fileName={currentFile.name}
          dateTaken={frameDates[currentFile.path]}
          tags={fileTags[currentFile.path] ?? []}
          favorite={favorites.has(currentFile.path)}
        />
      )}

      {isExifEnabled && exifData && (
        <div className={`exif-overlay ${controlsPosition === 'left' ? 'position-left' : ''} ${toast ? 'toast-visible' : ''}`}>
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
        {/* "sync" keeps the old slide mounted underneath while the star wipes in over it
            (see presenceModeFor); `custom` carries the nav direction so exiting
            slides mirror correctly too. */}
        <AnimatePresence mode={presenceModeFor(activeTransition)} custom={direction}>
          <motion.div
            key={currentFile.path}
            custom={direction}
            variants={currentTransition.variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={currentTransition.transition}
            style={{
              position: 'absolute', inset: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              // Sits on the slide wrapper, not the viewer, so it travels with
              // the slide through the transition instead of snapping.
              ...(ambientColor ? { backgroundColor: ambientColor } : {}),
            }}
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
                  // heavily blurred anyway — a small variant rasterizes far faster
                  <img src={getDisplayUrl(currentFile.path, 1600)} className="blurred-media" alt="" />
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
                  onError={handleVideoError}
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
                  src={getDisplayUrl(currentFile.path)}
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
          fileTags={fileTags}
          tagNames={tagNames}
          ratings={ratings}
          cullingDecisions={cullingDecisions}
          healthIssues={healthReport ? healthIssues : null}
          quickMoveFolders={quickMoveFolders}
          onSelect={(i) => {
            setDirection(i >= currentIndex ? 1 : -1);
            setCurrentIndex(i);
            setIsGridOpen(false);
          }}
          onClose={() => setIsGridOpen(false)}
          onBatchFavorite={batchFavorite}
          onBatchTag={batchTag}
          onBatchRating={batchRating}
          onBatchCulling={batchCulling}
          onBatchDelete={batchDelete}
          onBatchMove={batchMove}
          onScanHealth={openHealthScan}
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

      <LibraryHealthModal
        isOpen={isHealthOpen}
        roots={healthRoots}
        onClose={() => setIsHealthOpen(false)}
        onReport={setHealthReport}
        onFilesMoved={handleFilesDeleted}
        onMetadataRemoved={handleMetadataRemoved}
        onFilesRestored={handleFilesRestored}
      />

      <Toast message={toast} action={toastAction} positionLeft={controlsPosition === 'left'} />

      {isShortcutsOpen && <ShortcutsOverlay onClose={() => setIsShortcutsOpen(false)} />}

      {reactions.length > 0 && (
        <div className="reactions-layer">
          {reactions.map(r => (
            <span key={r.id} className="reaction-float" style={{ left: `${r.x}%` }}>{r.emoji}</span>
          ))}
        </div>
      )}
    </div>
  )
}

export default App

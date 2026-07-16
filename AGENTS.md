# photo-slap — Architecture Notes

Retro-styled Electron photo/video slideshow app by Eddy Sant, built with AI assistance. Modernized July 2026 (Electron 43, React 19, Vite 8, ESLint 9 flat config).

## Process model

Standard three-part Electron app built with `vite-plugin-electron`:

| Part | Source | Output | Notes |
|---|---|---|---|
| Main | `electron/main.ts` | `dist-electron/main.js` | ESM (`"type": "module"`), window + menu + protocol + all IPC handlers |
| Preload | `electron/preload.ts` | `dist-electron/preload.mjs` | `contextBridge` exposes `window.api` only |
| Renderer | `src/` | `dist/` | React 19, no direct Node access (`contextIsolation: true`, `nodeIntegration: false`) |

`npm run dev` runs Vite; the electron plugin builds main/preload in watch mode and launches Electron pointed at the dev server. `npm run build` = `tsc && vite build && electron-builder`.

**Vite 8 uses Rolldown**: bundler options for the main process live under `build.rolldownOptions` (NOT `rollupOptions` — those are silently ignored). `sharp` (native) and `heic-decode` (WASM) are externalized there and shipped via explicit `files` globs + `asarUnpack` in `electron-builder.json5`.

## The media:// protocol

Local media is served through a privileged custom scheme (`protocol.handle('media', ...)` in `electron/main.ts`) instead of `file://` — `webSecurity` stays enabled.

- URL shape: `media://local/<encoded absolute path>`, built by `src/utils.ts:getFileUrl`. The `local` host is a required placeholder: standard-scheme URLs swallow (and lowercase) the first path segment as a host if you omit it.
- **Allowlist**: only files under directories the user opened (folder picker, CLI arg) are served; anything else gets 403. Roots accumulate in `allowedRoots`.
- Scheme privileges include `supportFetchAPI` + `corsEnabled`, and every response carries `Access-Control-Allow-Origin: *` — without both, `fetch()` from the renderer/worker fails with "Failed to fetch" even though `<img>`/`<video>` tags work.
- **HEIC/HEIF**: Chromium can't decode them, and prebuilt sharp binaries can't either (HEVC is patent-encumbered — sharp only ships AVIF). So `heic-decode` (WASM libheif/libde265) decodes to raw RGBA and sharp encodes JPEG.
- **Display-sized variants** (`?w=<maxDim>`): the renderer never paints full-resolution originals — a 48MP photo is a ~200MB GPU texture, and several alive at once during a transition caused texture thrash (visible artifacts mid-star-wipe). Slideshow requests `?w=4096`, blurred smart background `?w=1600`, grid thumbnails `?w=512` (`getDisplayUrl` in `src/utils.ts`). sharp downscales (and bakes EXIF rotation); GIFs are excluded (animation), PNGs stay PNG (alpha). All derived images (transcodes + downscales) are **cached on disk** (`userData/image-cache`, keyed by path+mtime+size+dim, LRU-capped at 500MB). The preloader calls `img.decode()` so incoming slides are pixel-ready before the wipe starts.
- **Byte ranges**: `Range` requests get real 206 responses (`fs.createReadStream` + `Readable.toWeb`), and full responses advertise `Accept-Ranges: bytes`, so `<video>` seeking doesn't re-download the file.

## Launch options

- `photo-slap <directory>` (packaged) or `PHOTO_SLAP_DIR=<dir> npm run dev` — auto-opens that folder (renderer pulls it via `app:getAutoOpen` on mount; pull, not push, to avoid load-order races).
- `PHOTO_SLAP_DEBUG_PORT=<port>` — exposes the Chrome DevTools Protocol; used by `npm run test:e2e`.
- The app is **single-instance** (`requestSingleInstanceLock`); a second launch focuses the running window and, if given a directory argument, pushes its scan to the renderer over `app:openScan`. This also means dev and packaged builds can't run simultaneously.
- Folders can also arrive by **drag-and-drop** (renderer resolves paths via `webUtils.getPathForFile` in the preload — `File.path` no longer exists) or the intro screen's **Resume** button (`lastDirs` in electron-store). All ingestion paths funnel through `ingestScanResult` in App.

## Menus & displays

- `buildApplicationMenu()` in `electron/main.ts` owns the whole menu and is re-run on `screen` `display-added`/`display-removed` so **Window → Send to Display** stays current. `sendToDisplay` moves the window to a display's bounds and fullscreens it (leaving fullscreen first if needed — the macOS transition is animated, hence the `leave-full-screen` wait).
- The **Actions** menu lists every renderer keyboard shortcut using `registerAccelerator: false` (macOS): the key is *displayed* but not registered, so the renderer's keydown handler remains the single owner (registering `Space`/letter accelerators would swallow them from inputs). Menu clicks dispatch over the `menu:action` channel.
- True AirPlay initiation is impossible from Electron; the supported flow is macOS Screen Mirroring (extended display) + Send to Display, documented in the README.

## IPC channels (all defined in `electron/main.ts`, typed in `src/vite-env.d.ts`)

| Channel | Direction | Purpose |
|---|---|---|
| `dialog:openDirectory` | invoke | Folder picker (multi-select) → recursive scan → `{ paths, files, errors }` |
| `app:getAutoOpen` | invoke | Scan the CLI/env-provided directory, if any |
| `dir:scan` | invoke | Scan an arbitrary directory (drag-and-drop, Resume) and allowlist it |
| `files:getDates` | invoke | Date-taken per path: EXIF `DateTimeOriginal` from the first 256 KB, mtime fallback (16-way concurrent) |
| `app:openScan` | main → renderer | Scan result pushed from a second app launch |
| `file:delete` | invoke | Move file to Trash (`shell.trashItem`) |
| `file:move` | invoke | Quick-move to a target folder (rename, EXDEV copy+unlink fallback; refuses to overwrite) |
| `power:setBlocked` | invoke | `powerSaveBlocker` on/off — renderer keeps the display awake while playing |
| `file:showInFolder` | invoke | Reveal in Finder/Explorer |
| `file:getExif` | invoke | Read EXIF via `exifreader` → flattened `ExifData` or `null` |
| `store:get` / `store:set` | invoke | Settings persistence (`electron-store`) |
| `dialog:pickDirectory` | invoke | Folder picker without scanning (dedupe-from-start-screen); allowlists the dir |
| `dedupe:scan:exact` | invoke | Exact dupes across a *list* of roots: fast-glob → group by size → SHA-256 (videos optional) |
| `dedupe:scan:files` | invoke | Lists image or video paths across roots (perceptual hashing happens renderer-side) |
| `files:getInfo` | invoke | Size/mtime per path, for the dedupe compare cards |
| `menu:open-directory`, `menu:show-in-finder`, `menu:open-settings` | main → renderer | App menu items (Cmd+O / Cmd+Shift+O / Cmd+,) forward to renderer handlers |
| `menu:action` | main → renderer | Actions-menu items (next/prev/toggle-play/seek-forward/seek-back/reveal/delete) dispatch to the same handlers as the keyboard shortcuts |

## Renderer structure

- `App.tsx` — slideshow state (file list, index, playback), viewer, video controls. Scan results from any source (dialog, drag-drop, resume, CLI, second instance) go through `ingestScanResult`, which only sets `allFiles`; a single reactive effect derives the playable `files` list from `allFiles` + mediaFilter + sortOrder + shuffle, so persisted settings hydrating after launch re-sort automatically.
- **Date sort**: lazily fetches `files:getDates` the first time a date sort is active (toast: "Reading photo dates…"), cached in a ref until another folder is opened. Name sort runs first so it's the tiebreaker.
- `hooks/usePersistedState.ts` — `useState` that hydrates from electron-store on mount and persists on set; all settings use it.
- `components/ZoomPan.tsx` — wheel-zoom toward cursor / drag-pan / double-click toggle for photos. Transform state lives in refs and is written straight to the DOM (no re-render per pointermove); the wheel listener is attached manually to be non-passive. Resets on slide change via `resetKey`; reports `onZoomChange` so App suspends the Ken Burns class while zoomed.
- `components/SettingsMenu.tsx` — the options side panel (pure props). Rendered in the intro state too (settings and dedupe are usable before a folder is open); `hasFiles` hides file-specific actions there.
- The blurred smart-background video has **no autoPlay attribute**: the playback-sync effect in App is the single owner of play/pause/seek for both videos, so pausing the main video (or toggling smart background while paused) can't leave the blur playing.
- `components/DedupeModal.tsx` — duplicate finder wizard. One **strictness slider**: level 0 = exact (SHA-256 in main), levels 1–3 = perceptual with Hamming thresholds 4/12/20. Image hashing runs in `workers/phashWorker.ts` (module worker: fetch over media:// → `createImageBitmap` → 16×16 OffscreenCanvas → `blockhash-core`); videos (optional) are hashed by a frame sampled ~1s in, on the main thread — the `<video>` element MUST set `crossOrigin='anonymous'` or the canvas is tainted and `getImageData` throws (media:// is cross-origin to the app). Grouping is transitive union-find in `similarity.ts`. Review compares the group's first two files ("keeper" vs challenger); the survivor keeps facing the rest, so groups of any size are fully reviewed. Compare cards show filename/folder/size/dimensions (`files:getInfo` IPC + media load events) with the better side highlighted. Deletions are reported to App via `onFilesDeleted` so the slideshow drops them immediately.
- `components/Toast.tsx` — transient notices (no media found, unreadable folders); state lives in App (`showToast`).
- `transitions.ts` — slide transition variants; see below.
- Slideshow timer only runs for images; videos advance via `onEnded` and loop when paused. Next 10 images are preloaded via `new Image()`.

### Slide transitions

Framer-motion **variants** (`enter`/`center`/`exit`) on a keyed `motion.div` inside `AnimatePresence`, with the navigation direction (1/-1) passed as `custom` on BOTH the motion.div and AnimatePresence — the latter is what updates the already-mounted outgoing slide's exit when direction just flipped (baking direction into a plain `exit` prop leaves it one navigation stale). Directional styles (slide/flip/zoom) mirror when going backwards. The slide wrapper is `position: absolute; inset: 0` so slides can stack.

The **star wipe** needs the outgoing slide to stay visible while the incoming slide is revealed through a growing star-shaped `clip-path`:

- `AnimatePresence` uses `mode="sync"` for star (both slides mounted at once) and `mode="wait"` for everything else.
- `starPolygon(scale)` generates the polygon; scale 0 = collapsed point, scale 4 = inner vertices clear the screen corners (corner distance in % space ≈ 70.7; inner vertices sit at ≈ 18.6 × scale).
- The outgoing slide's `exit` keeps it fully visible (opacity drops only after a 0.65 s delay, once covered) and lowers `zIndex`.
- Don't reintroduce an opacity fade on the star variant — it degrades the wipe into a crossfade (the original bug).

- `components/GridView.tsx` — `G` thumbnail grid with filename filter; images lazy-load, videos get placeholder tiles; click jumps to the slide.
- **Favorites & tags** (`H`/`T`, `components/TagEditor.tsx`): stored in `.photo-slap.json` sidecars WITH the library, managed by `electron/libraryMeta.ts` (`library:load`/`library:save` IPC). Each path is owned by the deepest sidecar dir containing it; loads merge with shallower-wins, saves write entries back to their owning file (so unfavorites don't resurrect). Favorites/tag *edits* deliberately don't re-derive the playable list (refs, not deps) — only the filter toggles do, or a heart press would reset the slide index. Session-only filters (favoritesOnly/tagFilter) are intentionally not persisted.
- **Slide timer bar** (`showSlideTimer`): CSS width animation keyed by `currentIndex`, duration set inline from `slideDuration`.
- **Update check**: `checkForUpdates` in main hits the GitHub Releases API (unsigned builds can't Squirrel-update, so it opens the release page); quiet check 5s after launch in packaged builds, menu item for manual checks. Tag `v*` pushes trigger `.github/workflows/release.yml` (macOS runner → DMG → GitHub Release).
- **Quick-move** (`1`/`2`/`3`): target folders in settings (`quickMoveFolders`), moves via `file:move`, and the moved file leaves the slideshow through the same `handleFilesDeleted` path as deletions.
- **Resume position**: `resumePositions` in electron-store maps a joined folder-set key to the last index; Resume sets `pendingIndexRef`, consumed once the file list lands.
- The window sets `backgroundThrottling: false` — the slideshow may be playing while the window is occluded (Send to Display), and throttled rAF also freezes framer-motion mid-transition (this broke E2E runs when the window opened behind others).

## Gotchas / conventions

- `MediaFile`, `ExifData`, and `window.api` are ambient types in `src/vite-env.d.ts` — no imports needed in renderer code.
- **Keep setState updaters pure** (no setState inside another updater): StrictMode double-invokes updaters, which made arrow-key navigation skip a slide in dev until fixed.
- `blockhash-core` and `heic-decode` have no bundled types; minimal declarations live in `src/types/blockhash-core.d.ts` and `electron/heic-decode.d.ts`.
- `scanDirectory` skips dotfiles, collects per-directory errors (e.g. macOS `EPERM` on `Photos Library.photoslibrary`) into `errors`, and still returns the partial scan; the renderer surfaces the count in a toast.
- ESLint: flat config in `eslint.config.js`; `react-hooks/set-state-in-effect` is intentionally off (the slideshow resets per-slide state in effects), `no-explicit-any` off for the IPC boundary.
- `npm run build` requires the Electron binary; if `node_modules/electron/dist` is missing (npm `allow-scripts` blocking install scripts), run `node node_modules/electron/install.js`.

## Testing

- `npm test` — Vitest unit tests in `tests/` (scanner, exact dedupe, similarity grouping, star polygon geometry, media URL encoding). Config lives in `vitest.config.ts`, deliberately separate from `vite.config.ts` so the electron plugin doesn't launch during tests.
- `npm run test:e2e` — `scripts/e2e.mjs` generates an image fixture (deterministic mtimes; downloads a sample HEIC when online), seeds the star-wipe setting (user config backed up and restored), launches the real app with `PHOTO_SLAP_DIR` + `PHOTO_SLAP_DEBUG_PORT`, and asserts over CDP: media:// serving + 403 allowlist, HEIC transcode, star-wipe clip-path interpolation, date sorting, zoom/pan, and the full dedupe review flow. Not headless; needs the single-instance lock free. Gotcha: the very first slide mounts before settings hydrate, so transition assertions need one warm-up slide change.

## Improvement ideas (not yet done)

1. **Code signing & notarization** — builds are unsigned; Gatekeeper blocks them on other Macs, and it's what blocks true self-installing auto-update (Squirrel requires a signature).
2. **Dedupe review history** — remember skipped/kept pairs so re-scans don't re-ask.
3. **Tag filter in grid view** — the grid filters by filename only; tags/favorites could be filterable there too.
4. **Sidecar conflict handling** — concurrent edits from two machines (synced folders) last-write-wins with no merge.

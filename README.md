# photo-slap

A photo & video slideshow app with a retro pixel look for the desktop, built with Electron, React, and TypeScript.

By [Eddy Sant](https://github.com/eddysant), built with AI assistance.

![Electron](https://img.shields.io/badge/Electron-43-9feaf9) ![React](https://img.shields.io/badge/React-19-61dafb) ![Vite](https://img.shields.io/badge/Vite-8-646cff) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

Open a folder, get a full-screen slideshow. Then use it to actually tidy the
folder up: cull, tag, find duplicates, and check the library for damage.

```bash
brew tap eddysant/tap
brew install --cask photo-slap
```

Images: `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` `.heic` `.heif` — Videos: `.mp4` `.webm` `.ogg` `.gifv`

---

## Watching

- **Slideshow** — open folders by dialog, drag-and-drop, or a command-line argument. Photos advance on a timer (2s–1min); videos play through, then advance. A video that can't be decoded is skipped rather than stalling the show.
- **Transitions** — Fade, Slide, Zoom, Flip, a classic **Star Wipe** (the new slide revealed through a growing star over the old one), or **Surprise Me**, which picks a different one for every slide. Directional styles mirror when you navigate backwards.
- **Ken Burns** — slow random pan/zoom on photos.
- **Smart Background** — a blurred, darkened copy of the current media fills the letterbox area, optionally for videos too.
- **Zoom & pan** — scroll to zoom toward the cursor, drag to pan, double-click to toggle. Pinch works too.
- **Sorting & shuffle** — natural filename order or date taken (EXIF capture date, file-modified fallback). Shuffle remembers what you've seen per library, across restarts: nothing repeats until the set completes a cycle. Progress and a reset are in Settings.
- **Video controls** — scrubber, volume, mute, click-to-pause, `M`/`N` to skip ±10s.
- **EXIF overlay** — camera, lens, ISO, aperture, shutter, date.
- **Slide timer bar** — a thin progress bar showing when the next slide lands.
- **Photo-frame mode** (`P`) — ambient clock, date, capture date, and tags. Pair with **Auto-Play On Open** and Send to Display to turn a spare screen into a photo frame.

## Organizing

- **Favorites, tags, ratings & decisions** — `H` hearts a photo, `T` opens a quick-tag editor; the grid and culling bar handle 1–5 stars and Keep/Reject. All of it lives in `.photo-slap.json` sidecars *next to your photos* (relative paths, so folders can move) rather than in the app. Opening a parent folder picks up and merges sidecars from subfolders.
- **Grid view** (`G`) — virtualized thumbnails, smooth at tens of thousands of photos. Filename, tag, favorite, health, rating, and culling filters compose together, and select mode batch-applies favorites, tags, ratings, decisions, moves, or deletes.
- **Culling mode** — a paused, photos-only review bar. `K`/`Enter` to Keep, `X` to Reject, `H` to favorite, `1`–`3` to file into a quick-move folder, and 1–5 stars from the bar itself. Decisions are non-destructive and live in the sidecar; Trash stays a separate action.
- **Quick-move folders** — assign up to three targets in Settings, then `1`/`2`/`3` moves the current file. With `Delete`, it makes triaging a photo dump fast.
- **Safe delete** — files go to the system Trash, never hard-deleted. Deleting from the slideshow or the grid is undoable: the file leaves the view at once but the trashing is held for a few seconds while the toast offers **Undo**. Duplicate-finder deletions apply immediately — you've just compared the two side by side — and are recoverable from the Trash like any other.

## Cleaning up

- **Duplicate finder** — one strictness slider from **Exact** (byte-for-byte SHA-256) through **Strict / Normal / Loose** perceptual matching (16×16 blockhash + Hamming distance, in a Web Worker). Optionally includes videos: byte-identical at Exact, matched by a sampled frame at similarity levels, which catches re-encodes. Scans every folder in the session at once so cross-folder duplicates group together. Side-by-side review shows filename, folder, size, and dimensions with the better side highlighted, and walks groups of any size. Available from the start screen with its own folder picker.
- **Library health & quarantine** — checks for corrupt or unreadable media, suspiciously tiny images (under 320px or 10KB), unsupported formats, photos with no capture date, and sidecar entries pointing at missing files. Filterable, exportable as CSV. Corrupt files move to a hidden `.photo-slap-quarantine` folder with a recovery manifest; the manager can inspect, restore, reveal, permanently delete, or export them. Restores never overwrite an existing file.

## Sharing a show

- **Send to Display** — `Window → Send to Display` moves the slideshow fullscreen onto any connected screen. The display stays awake while playing, and playback isn't throttled when the window is covered.
- **Phone remote** — enable *Phone Remote (LAN)* in Settings and scan the QR code. Your phone gets a live thumbnail of the current slide (swipe to navigate) plus play and favorite controls.
- **Party mode** — anyone who scans the QR can:
  - tap emoji **reactions** that float up over the show,
  - **pick what plays next** from a thumbnail grid of the library — their choice jumps the queue,
  - **upload their own photos** from their phone browser, landing in a `guests/` folder and joining the running slideshow immediately.

  Guests only ever address slides by index; no filesystem path is ever sent to a phone. Uploads are extension-whitelisted, size-capped per file and per session, and never overwrite.

## Keyboard

Press **`?`** in the app for the full list on screen. Everything is also in the **Actions** menu.

| | |
|---|---|
| `←` `→` | Previous / next slide |
| `Space` | Play / pause |
| `G` / `P` / `T` | Grid / photo frame / tags |
| `H` | Favorite |
| `K` `Enter` / `X` | Culling keep / reject |
| `1`–`3` | Quick-move to folder |
| `M` / `N` | Video ±10 seconds |
| `F` | Reveal in Finder |
| `Delete` `Backspace` | Move to Trash (undoable) |
| `?` / `Esc` | Shortcuts / close overlays |

## Under the hood

- **Built for big libraries** — display-sized image serving with a capped derivation queue, a virtualized grid, and collator-based sorting. A 5,000-photo library opens in about a second and the grid stays at ~50 DOM nodes regardless of size.
- **HEIC** — iPhone photos are transcoded to JPEG on the fly (WASM HEVC decode + sharp encode in the main process) and cached on disk, so each file pays the decode cost once.
- **Sandboxed renderer** — media is streamed over a custom `media://` protocol restricted to folders you've opened, with Chromium web security fully enabled. The renderer runs under a strict Content Security Policy with no external origins, can't be navigated away from the app, and every path it names is checked against that allowlist. Fonts are bundled, so the app is fully offline-capable.
- **Named settings presets** — one click configures **Photo Frame**, **Party**, **Culling**, or **TV**. Presets are starting points; every setting stays adjustable.
- **Settings everywhere** — a sectioned panel grouping library order, presentation, playback, review, and library tools, from the control bar, start screen, or `Cmd+,`.
- **Resume** — the intro screen reopens your last folder at the slide you were on.
- **Updates** — checks GitHub Releases on launch and via *photo-slap → Check for Updates…*. Unsigned builds can't self-install, so it opens the download page.

## Installing from GitHub Releases

Builds are not code-signed (that needs an Apple Developer membership), so macOS
quarantines the download and reports the app as *"damaged and can't be opened."*
The file is fine — after dragging **photo-slap.app** to Applications, clear the
quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/photo-slap.app
```

It opens normally from then on — but **the flag comes back on every upgrade**,
because each install stages a fresh copy of the app. (`xattr -cr` also works,
but it strips *every* extended attribute; the command above removes only the
quarantine flag.)

Apps you build yourself (`npm run build`) are never quarantined and don't need
this. Signing and notarizing would remove the step entirely — see the
improvement notes in [CLAUDE.md](CLAUDE.md).

The Homebrew Cask is published from [eddysant/homebrew-tap](https://github.com/eddysant/homebrew-tap)
and follows the latest GitHub Release. The macOS package is Apple Silicon.

## Casting to a TV (AirPlay)

Electron apps can't start an AirPlay stream directly (that API is Safari-only), but the two-step equivalent works well:

1. On your Mac: **Control Center → Screen Mirroring → your TV**, set to *Use As Separate Display*.
2. In photo-slap: **Window → Send to Display → your TV**.

The slideshow goes fullscreen on the TV and keyboard controls keep working from your Mac. The display list updates as screens connect and disconnect.

## Development

```bash
npm install         # install dependencies
npm run dev         # Vite + Electron with hot reload
npm run lint        # ESLint (flat config, eslint.config.js)
npm test            # unit tests (vitest)
npm run test:smoke  # the built app over file:// under the production CSP
npm run test:e2e    # launches the real app and drives it over CDP
npx tsc             # type-check only
npm run build       # type-check, bundle, and package with electron-builder
```

`test:smoke` and `test:e2e` are not headless — an app window appears briefly.
Both need any running photo-slap closed first (the app is single-instance), and
the E2E backs up and restores your settings. `test:smoke -- --app <path>` points
it at a packaged `.app` so asar packaging is covered too; CI runs it that way
before publishing a release.

Packaged installers land in `release/<version>/` (macOS DMG, Windows NSIS — see [electron-builder.json5](electron-builder.json5)).

Open a folder on launch during development with `PHOTO_SLAP_DIR=~/Pictures npm run dev`,
or from a packaged build with `photo-slap ~/Pictures/vacation`.

## Project layout

```
electron/               Main & preload (bundled to dist-electron/)
  main.ts               Window, menu, CSP, media:// protocol, IPC handlers
  preload.ts            contextBridge → window.api
  pathAccess.ts         The allowlist every path-touching handler checks
  fileScanner.ts        Recursive scanner; owns the supported-format list
  libraryMeta.ts        .photo-slap.json sidecar load/merge/save
  libraryHealth.ts      Diagnostics, repair, quarantine manifest
  dedupe.ts             Exact duplicates (size grouping + SHA-256)
  remoteServer.ts       LAN remote: transport, browse/queue, reactions, uploads
  remoteGuard.ts        Session token, auth throttle, upload budget
  guestUpload.ts        Filename sanitizing and collision-free naming
  concurrencyLimit.ts   Caps simultaneous image derivations
src/                    React renderer
  App.tsx               Slideshow state and viewer
  components/           SettingsMenu, GridView, DedupeModal, LibraryHealthModal,
                        QuarantineManager, ShortcutsOverlay, TagEditor, ZoomPan, …
  hooks/                useLibraryMeta, useSlideshowPlayback, usePendingDeletes,
                        useRemote, useImagePreloader, usePersistedState
  workers/phashWorker.ts  Perceptual hashing off the main thread
  transitions.ts        Transition variants, the star wipe, random selection
  playlist.ts           Position maths (clamping, surviving neighbour)
  shuffleHistory.ts     No-repeat shuffle cycles
  similarity.ts         Transitive perceptual-hash grouping (union-find)
  shortcuts.ts          The keyboard shortcut list, shared with the help overlay
tests/                  Vitest unit tests
scripts/e2e.mjs         End-to-end test (CDP-driven)
scripts/smoke-packaged.mjs  Smoke test for the shipped configuration
```

See [CLAUDE.md](CLAUDE.md) for the architecture walkthrough, IPC reference, and known caveats.

## Settings persistence

All settings persist across launches via [`electron-store`](https://github.com/sindresorhus/electron-store)
in the main process, over the `store:get` / `store:set` IPC channels. No-repeat
shuffle history uses the same store, scoped by the sorted library roots plus the
active media filter, and is written on a debounce rather than on every slide.

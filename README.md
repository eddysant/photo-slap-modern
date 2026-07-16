# photo-slap

A retro, Balatro-inspired photo & video slideshow app for the desktop, built with Electron, React, and TypeScript.

By [Eddy Sant](https://github.com/eddysant), built with AI assistance.

![Electron](https://img.shields.io/badge/Electron-43-9feaf9) ![React](https://img.shields.io/badge/React-19-61dafb) ![Vite](https://img.shields.io/badge/Vite-8-646cff) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

## Features

- **Slideshow** — open one or more folders (dialog, drag-and-drop onto the window, or a command-line argument) and play photos and videos full-screen. Images advance on a configurable timer (2s–1min); videos play through once, then advance. The intro screen offers to resume your last folder.
- **Zoom & pan** — scroll to zoom toward the cursor, drag to pan, double-click to toggle.
- **Sorting** — natural filename order, or by date taken (EXIF capture date with file-modified fallback), newest or oldest first.
- **Transitions** — Fade, Slide, Zoom, Flip, and a classic **Star Wipe** (the new slide is revealed through a growing star over the old one). Directional transitions mirror when you navigate backwards.
- **Ken Burns effect** — slow random pan/zoom on photos.
- **Smart Background** — blurred, darkened copy of the current media fills the letterbox area (optionally for videos too).
- **Media filtering & shuffle** — photos only / videos only / both, natural filename sort, or Fisher-Yates shuffle.
- **Video controls** — scrubber, volume, mute, click-to-pause.
- **EXIF overlay** — camera, lens, ISO, aperture, shutter speed, and date for photos.
- **Duplicate finder** — one strictness slider from **Exact** (byte-for-byte, SHA-256) through **Strict / Normal / Loose** perceptual matching (16×16 blockhash + Hamming distance, computed in a Web Worker), each level explained in plain language. Optionally includes videos: byte-identical at Exact, matched by a sampled frame at similarity levels (catches re-encoded copies). Scans **all folders of the session at once**, so duplicates across folders group together. The side-by-side review shows filename, folder, file size, and dimensions — with the larger file/resolution highlighted — and walks through groups of any size. Deletions update the running slideshow immediately. Available straight from the start screen with its own folder picker.
- **Settings everywhere** — the options panel opens from the control bar, the start screen, or the app menu (`Cmd+,`), so the slideshow can be configured before opening a folder.
- **HEIC support** — iPhone photos are transcoded to JPEG on the fly (WASM HEVC decode + sharp encode in the main process).
- **Safe media serving** — files are streamed over a custom `media://` protocol restricted to folders you've opened; Chromium web security stays fully enabled.
- **Safe delete** — files are moved to the system Trash, never hard-deleted.
- **Open a folder from the command line** — `photo-slap ~/Pictures/vacation` (or `PHOTO_SLAP_DIR=... npm run dev` during development).
- **Grid view** — press `G` for a virtualized thumbnail grid (smooth even with tens of thousands of photos) with filename, favorites, and tag filters. Click a cell to jump there, or flip on **Select** mode to batch favorite/tag/move/delete.
- **Photo-frame mode** — press `P` for an ambient overlay with a clock, date, and the photo's capture date and tags. Pair with **Auto-Play On Open** and Send to Display to turn a spare screen into a photo frame.
- **Phone remote** — enable *Phone Remote (LAN)* in Settings and scan the QR code: your phone gets prev/play/next/favorite buttons and live status. Token-guarded, works anywhere on your Wi-Fi — perfect while casting to a TV.
- **Favorites & tags** — `H` hearts a photo, `T` opens a quick-tag editor with your reusable tag vocabulary; filter the slideshow to favorites or a tag from Settings. Stored in `.photo-slap.json` sidecar files *next to your photos* (relative paths, so folders can move), not in the app — opening a parent folder picks up and merges sidecars saved in subfolders.
- **Quick-move folders** — assign up to three target folders in Settings, then press `1`/`2`/`3` to move the current file there. Combined with `Delete`, it makes triaging a photo dump fast.
- **Keyboard shortcuts** — `←`/`→` previous/next, `Space` play/pause, `G` grid, `P` photo frame, `H` favorite, `T` tags, `F` reveal in Finder, `M`/`N` video ±10 seconds, `1`–`3` quick-move, `Delete`/`Backspace` delete, `Esc` close overlays. All of them are listed in the **Actions** menu in the menu bar.
- **Slide timer bar** — a thin progress bar shows when the next slide lands (can be hidden in Settings).
- **Updates** — the app checks GitHub Releases on launch (and via *photo-slap → Check for Updates…*) and points you at new versions. Unsigned builds can't self-install, so it opens the download page.
- **Send to Display** — `Window → Send to Display` moves the slideshow fullscreen onto any connected screen. The display stays awake while the show plays, and playback isn't throttled when the window is covered.
- **Fast HEIC** — transcoded iPhone photos are cached on disk, so each HEIC only pays the decode cost once.
- **Resume where you left off** — the intro screen's Resume button reopens the last folder at the slide you were on.

Supported formats: `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` `.heic` `.heif` (images), `.mp4` `.webm` `.ogg` `.gifv` (videos).

## Installing from GitHub Releases

Builds are not code-signed (that requires an Apple Developer membership), so
macOS quarantines the download and reports the app as *"damaged and can't be
opened."* The file is fine — after dragging **photo-slap.app** to
Applications, clear the quarantine flag once:

```bash
xattr -cr /Applications/photo-slap.app
```

It opens normally from then on. Apps you build yourself (`npm run build`)
never get quarantined and don't need this.

## Casting to a TV (AirPlay)

Electron apps can't start an AirPlay stream directly (that API is Safari-only), but the two-step equivalent works well:

1. On your Mac: **Control Center → Screen Mirroring → your TV**, and set it to *Use As Separate Display*.
2. In photo-slap: **Window → Send to Display → your TV**. The slideshow goes fullscreen on the TV; keyboard controls keep working from your Mac.

The display list updates automatically as screens connect and disconnect.

## Development

```bash
npm install       # install dependencies
npm run dev       # start Vite + Electron with hot reload
npm run lint      # ESLint (flat config, eslint.config.js)
npm test          # unit tests (vitest)
npm run test:e2e  # end-to-end: launches the real app and drives it over CDP
npx tsc           # type-check only
npm run build     # type-check, bundle, and package with electron-builder
```

The E2E suite is not headless — an app window appears briefly. It backs up
and restores your settings, and needs any running photo-slap instance closed
first (the app is single-instance).

Packaged installers land in `release/<version>/` (macOS DMG, Windows NSIS — see [electron-builder.json5](electron-builder.json5)).

## Project layout

```
electron/            Main & preload process code (bundled to dist-electron/)
  main.ts            Window, menu, media:// protocol (allowlist + HEIC transcode), IPC
  preload.ts         contextBridge → exposes window.api to the renderer
  fileScanner.ts     Recursive media-file directory scanner
  dedupe.ts          Exact-duplicate detection (size grouping + SHA-256)
src/                 React renderer
  App.tsx            Slideshow state and viewer
  components/        SettingsMenu, DedupeModal, IntroScreen, Toast, ZoomPan
  workers/phashWorker.ts   Perceptual hashing off the main thread
  hooks/usePersistedState.ts   useState + electron-store persistence
  transitions.ts     Slide transition variants (incl. the star wipe)
  similarity.ts      Transitive perceptual-hash grouping (union-find)
  utils.ts           media:// URL encoding helper
  vite-env.d.ts      MediaFile / ExifData / window.api type declarations
tests/               Vitest unit tests
scripts/e2e.mjs      End-to-end test (CDP-driven)
```

See [CLAUDE.md](CLAUDE.md) for a deeper architecture walkthrough, IPC channel reference, and known caveats.

## Settings persistence

All settings (shuffle, transition, slide duration, smart background, volume, controls position, …) persist across launches via [`electron-store`](https://github.com/sindresorhus/electron-store) in the main process, accessed over the `store:get` / `store:set` IPC channels.

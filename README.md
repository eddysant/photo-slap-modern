# photo-slap

A retro, Balatro-inspired photo & video slideshow app for the desktop, built with Electron, React, and TypeScript.

![Electron](https://img.shields.io/badge/Electron-43-9feaf9) ![React](https://img.shields.io/badge/React-19-61dafb) ![Vite](https://img.shields.io/badge/Vite-8-646cff) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

## Features

- **Slideshow** — open one or more folders and play photos and videos full-screen. Images advance on a configurable timer (2s–1min); videos play through once, then advance.
- **Transitions** — Fade, Slide, Zoom, Flip, and a classic **Star Wipe** (the new slide is revealed through a growing star over the old one).
- **Ken Burns effect** — slow random pan/zoom on photos.
- **Smart Background** — blurred, darkened copy of the current media fills the letterbox area (optionally for videos too).
- **Media filtering & shuffle** — photos only / videos only / both, natural filename sort, or Fisher-Yates shuffle.
- **Video controls** — scrubber, volume, mute, click-to-pause.
- **EXIF overlay** — camera, lens, ISO, aperture, shutter speed, and date for photos.
- **Duplicate finder** — exact duplicates (SHA-256 of file contents, pre-filtered by size) or visually similar photos (16×16 perceptual hash + Hamming distance, computed in a Web Worker), with a side-by-side keep/delete review that walks through groups of any size. Deletions update the running slideshow immediately.
- **HEIC support** — iPhone photos are transcoded to JPEG on the fly (WASM HEVC decode + sharp encode in the main process).
- **Safe media serving** — files are streamed over a custom `media://` protocol restricted to folders you've opened; Chromium web security stays fully enabled.
- **Safe delete** — files are moved to the system Trash, never hard-deleted.
- **Open a folder from the command line** — `photo-slap ~/Pictures/vacation` (or `PHOTO_SLAP_DIR=... npm run dev` during development).
- **Keyboard shortcuts** — `←`/`→` previous/next, `Space` play/pause, `Delete`/`Backspace` delete, `Esc` close settings.

Supported formats: `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` `.heic` `.heif` (images), `.mp4` `.webm` `.ogg` `.gifv` (videos).

## Development

```bash
npm install       # install dependencies
npm run dev       # start Vite + Electron with hot reload
npm run lint      # ESLint (flat config, eslint.config.js)
npx tsc           # type-check only
npm run build     # type-check, bundle, and package with electron-builder
```

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
  components/        SettingsMenu, DedupeModal, IntroScreen, Toast
  workers/phashWorker.ts   Perceptual hashing off the main thread
  hooks/usePersistedState.ts   useState + electron-store persistence
  transitions.ts     Slide transition variants (incl. the star wipe)
  utils.ts           media:// URL encoding helper
  vite-env.d.ts      MediaFile / ExifData / window.api type declarations
scripts/             One-off asset utilities (icon transparency)
```

See [CLAUDE.md](CLAUDE.md) for a deeper architecture walkthrough, IPC channel reference, and known caveats.

## Settings persistence

All settings (shuffle, transition, slide duration, smart background, volume, controls position, …) persist across launches via [`electron-store`](https://github.com/sindresorhus/electron-store) in the main process, accessed over the `store:get` / `store:set` IPC channels.

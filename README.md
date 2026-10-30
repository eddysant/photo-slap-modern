# photo-slap

A photo and video slideshow for the desktop, with a retro pixel look.

Open a folder, get a full-screen show. Then use it to actually tidy that folder
up: cull, tag, find duplicates, and check the library for damage.

By [Eddy Sant](https://github.com/eddysant), built with AI assistance.

![Electron](https://img.shields.io/badge/Electron-43-9feaf9) ![React](https://img.shields.io/badge/React-19-61dafb) ![Vite](https://img.shields.io/badge/Vite-8-646cff) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

```bash
brew tap eddysant/tap
brew install --cask photo-slap
```

**Photos** `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` `.heic` `.heif`

**Videos** `.mp4` `.webm` `.ogg` `.gifv`

---

## Watching

**Open a folder any way you like** — the dialog, drag-and-drop, or
`photo-slap ~/Pictures/vacation` from the command line.

**The show keeps moving.** Photos advance on a timer you set (2 seconds to a
minute); videos play through and then advance. A video the system can't decode
is skipped rather than left stalling the show.

**Folders stay live.** Photos you copy, AirDrop or sync into an open folder
join the slideshow within a couple of seconds, and ones that disappear drop out
quietly. A file still being copied is left alone until it has finished writing.
Nothing to turn on, and no need to relaunch.

**Transitions** — Fade, Slide, Zoom, Flip, a classic **Star Wipe** (the new
slide revealed through a growing star over the old one), a **CRT Power-On**
that collapses the slide to a glowing line and snaps it back out, or **Surprise
Me**, which picks a different one every time. **Transition speed** runs any
of them at Normal, Fast, Faster or nearly instant, so the same style can be
the centrepiece of a photo frame or stay out of the way while you cull.

**Filling the letterbox** — bars beside a photo can hold either a blurred,
darkened copy of it (*Smart Background*) or its own average colour (*Ambient*).
Either way, portrait shots on a widescreen TV stop floating in a black void.

Plus **Ken Burns** pan and zoom, **scroll-to-zoom and drag-to-pan** (pinch
works too), an **EXIF overlay** with camera, lens and exposure, and a thin
**timer bar** showing when the next slide lands.

**HEIC just works.** iPhone photos are converted for display on the fly and
cached, so each one pays that cost once rather than every time it comes round.

**Sorting and shuffle** — natural filename order, or date taken from the EXIF
capture date. Shuffle remembers what you have already seen, per library and
across restarts: nothing repeats until the set completes a cycle.

**Photo-frame mode** (`P`) adds an ambient clock, the date, the photo's capture
date and its tags. Pair it with *Auto-Play On Open* and *Send to Display* and a
spare screen becomes a photo frame.

## Organizing

**Favorites, tags, ratings and decisions.** `H` hearts a photo, `T` opens a
quick-tag editor, and the grid and culling bar handle 1–5 stars and
Keep/Reject.

All of it lives in `.photo-slap.json` files *next to your photos* rather than
inside the app, using relative paths so folders can be moved. Opening a parent
folder picks up and merges the sidecars from its subfolders.

If you would rather the app left your folders alone, **Options › Review
workflow › Save tags & favorites › This session only** writes nothing at all.
Existing sidecars are still read; anything you change is gone when you quit.
Switch back and it saves what the session is holding.

**Grid view** (`G`) — virtualized thumbnails, smooth at tens of thousands of
photos. Filename, tag, favorite, health, rating and culling filters compose
together, and select mode batch-applies favorites, tags, ratings, decisions,
moves or deletes.

**Culling mode** — a paused, photos-only review bar. `K` or `Enter` to keep,
`X` to reject, `H` to favorite, `1`–`3` to file into a quick-move folder, and
stars from the bar itself. Decisions are non-destructive and live in the
sidecar; Trash stays a separate action.

**Quick-move folders** — assign up to three targets in Settings, then `1`, `2`
or `3` files the current photo away. With `Delete`, it makes triaging a photo
dump fast.

**Safe delete** — files go to the system Trash, never hard-deleted. Deleting
from the slideshow or the grid is undoable: the file leaves the view at once,
but the trashing is held for a few seconds while the toast offers **Undo**.
Duplicate-finder deletions apply immediately — you have just compared the two
side by side — and are recoverable from the Trash like anything else.

## Cleaning up

**Duplicate finder** — one strictness slider, from **Exact** (byte-for-byte)
through **Strict**, **Normal** and **Loose** visual matching. It can include
videos, matching re-encodes by a sampled frame. Every folder in the session is
scanned at once, so cross-folder duplicates group together, and the
side-by-side review shows filename, folder, size and dimensions with the better
side highlighted. Available from the start screen with its own folder picker.

**Library health and quarantine** — checks for corrupt or unreadable media,
suspiciously tiny images (under 320px or 10KB), unsupported formats, photos
with no capture date, and tags pointing at files that no longer exist. The report is filterable and
exports as CSV.

Corrupt files move to a hidden `.photo-slap-quarantine` folder with a recovery
manifest, and the manager can inspect, restore, reveal, permanently delete or
export them. A restore never overwrites an existing file.

## Sharing a show

**Send to Display** — `Window → Send to Display` moves the slideshow fullscreen
onto any connected screen. The display stays awake while playing, and playback
is not throttled when the window is covered.

**Phone remote** — turn on *Phone Remote (LAN)* in Settings and scan the QR
code. Your phone gets a live thumbnail of the current slide, swipe to navigate,
and play and favorite controls.

**Party mode** — anyone who scans the QR code can also:

- tap emoji **reactions** that float up over the show,
- **pick what plays next** from a thumbnail grid of the library — their choice
  jumps the queue,
- **upload photos from their phone**, landing in a `guests/` folder and joining
  the running slideshow immediately.

Guests only ever address slides by number; no filesystem path is ever sent to a
phone. Uploads are limited to known image and video types, capped per file and
per session, and never overwrite anything.

## Settings and presets

**Named presets** — one click configures **Photo Frame**, **Party**, **Culling**
or **TV**. They are starting points; every setting stays adjustable afterwards.

**One panel, reachable from anywhere** — library order, presentation, playback,
review and library tools, grouped by task, from the control bar, the start
screen or `Cmd+,`.

**Resume** — the start screen reopens your last folder at the slide you were on.

**Offline and self-contained** — nothing leaves your machine except the update
check. Fonts are bundled, media is read only from folders you have opened, and
the phone remote runs on your own network.

**Updates** — checks GitHub Releases on launch, and on demand from *photo-slap
→ Check for Updates…*. Unsigned builds cannot install themselves, so it opens
the download page.

## Keyboard

Press **`?`** in the app for the full list on screen. Everything is also in the
**Actions** menu.

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

## Casting to a TV

Electron apps cannot start an AirPlay stream directly — that API is
Safari-only — but the two-step equivalent works well:

1. On your Mac: **Control Center → Screen Mirroring → your TV**, set to *Use As
   Separate Display*.
2. In photo-slap: **Window → Send to Display → your TV**.

The slideshow goes fullscreen on the TV and the keyboard still controls it from
your Mac. The display list updates as screens connect and disconnect.

## Installing from a GitHub Release

Builds are not code-signed — that needs a paid Apple Developer membership — so
macOS quarantines the download and reports the app as *"damaged and can't be
opened."* The file is fine. Drag **photo-slap.app** to Applications, then clear
the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/photo-slap.app
```

It opens normally from then on, but **the flag comes back on every upgrade**,
because each install stages a fresh copy. (`xattr -cr` also works, but it
strips *every* extended attribute; the command above removes only the
quarantine flag.)

Apps you build yourself are never quarantined and need none of this. The
Homebrew cask is published from
[eddysant/homebrew-tap](https://github.com/eddysant/homebrew-tap) and follows
the latest release. The macOS package is Apple Silicon.

## Development

```bash
npm install
npm run dev     # Vite + Electron with hot reload
npm test        # unit tests
npm run build   # type-check, bundle, and package
```

Open a folder on launch with `PHOTO_SLAP_DIR=~/Pictures npm run dev`.

[AGENTS.md](AGENTS.md) is the full architecture walkthrough: the process model,
the `media://` protocol and its allowlist, the IPC reference, the renderer
structure, the memory work, the test suites, and the caveats worth knowing
before changing any of it.

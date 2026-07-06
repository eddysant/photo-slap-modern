import { app, BrowserWindow, ipcMain, dialog, shell, net, protocol, screen, powerSaveBlocker, Menu, MenuItemConstructorOptions } from 'electron'

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { statSync, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import crypto from 'node:crypto'
import Store from 'electron-store'
import sharp from 'sharp'
import decodeHeic from 'heic-decode'
import { scanDirectory } from './fileScanner'
import { findExactDuplicates, scanFiles } from './dedupe'
import ExifReader from 'exifreader';

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
process.env.APP_ROOT = path.join(__dirname, '..')




// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// Set App Name for macOS
if (process.platform === 'darwin') {
  app.setName('photo-slap');
}

// Store init
const store = new Store();

// --------- media:// protocol ---------
// Media is served through a privileged custom scheme instead of file://
// with webSecurity disabled. Only files inside directories the user has
// explicitly opened via the folder picker are served.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    // corsEnabled + the Access-Control-Allow-Origin response header let
    // fetch() (used by the perceptual-hash worker) read media responses.
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

const allowedRoots = new Set<string>();

function isAllowedPath(filePath: string): boolean {
  for (const root of allowedRoots) {
    if (filePath === root || filePath.startsWith(root + path.sep)) return true;
  }
  return false;
}

// media://local/Users/me/pic.jpg -> /Users/me/pic.jpg (or C:\... on Windows)
function mediaUrlToPath(urlStr: string): string {
  const url = new URL(urlStr);
  let p = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:[/\\]/.test(p)) p = p.slice(1); // strip leading slash of Windows drive paths
  return path.normalize(p);
}

// CORS header so fetch() from the renderer and its workers can read media
// (plain <img>/<video> tags don't need it, the perceptual-hash worker does).
const MEDIA_CORS = { 'Access-Control-Allow-Origin': '*' };

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.ogg': 'video/ogg', '.gifv': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const mimeFor = (p: string) => MIME_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

// Transcoded HEIC JPEGs are cached on disk (keyed by path+mtime+size) so
// each photo only pays the WASM decode once, ever.
let heicCacheDir: string | null = null;

async function transcodeHeic(filePath: string): Promise<Buffer> {
  let cachePath: string | null = null;
  if (heicCacheDir) {
    try {
      const stat = await fs.stat(filePath);
      const key = crypto.createHash('sha1').update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex');
      cachePath = path.join(heicCacheDir, `${key}.jpg`);
      return await fs.readFile(cachePath); // cache hit
    } catch {
      // cache miss — decode below
    }
  }

  const buffer = await fs.readFile(filePath);
  const { width, height, data } = await decodeHeic({ buffer });
  const jpeg = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 90 })
    .toBuffer();
  if (cachePath) fs.writeFile(cachePath, jpeg).catch(() => { });
  return jpeg;
}

async function handleMediaRequest(request: Request): Promise<Response> {
  const filePath = mediaUrlToPath(request.url);

  if (!isAllowedPath(filePath)) {
    return new Response('Forbidden', { status: 403, headers: MEDIA_CORS });
  }

  // Chromium can't decode HEIC/HEIF; transcode to JPEG on the fly.
  // heic-decode (WASM libheif) handles the HEVC decode — prebuilt sharp
  // binaries can't, HEVC being patent-encumbered — then sharp encodes
  // the raw pixels to JPEG.
  if (/\.(heic|heif)$/i.test(filePath)) {
    try {
      const jpeg = await transcodeHeic(filePath);
      return new Response(new Uint8Array(jpeg), {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600', ...MEDIA_CORS },
      });
    } catch (e) {
      console.error(`Failed to transcode ${filePath}`, e);
      return new Response('Decode failed', { status: 500, headers: MEDIA_CORS });
    }
  }

  // Byte-range support so <video> can seek without downloading everything
  const rangeHeader = request.headers.get('range');
  const rangeMatch = rangeHeader && /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (rangeMatch) {
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      return new Response('Not Found', { status: 404, headers: MEDIA_CORS });
    }
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, ...MEDIA_CORS },
      });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': mimeFor(filePath),
        ...MEDIA_CORS,
      },
    });
  }

  const res = await net.fetch(pathToFileURL(filePath).toString());
  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes'); // invite the player to seek with ranges
  for (const [k, v] of Object.entries(MEDIA_CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// Scan a directory and permit media:// to serve from it
async function scanAndAllow(dir: string) {
  const resolved = path.resolve(dir);
  allowedRoots.add(path.normalize(resolved));
  const { files, errors } = await scanDirectory(resolved);
  return { paths: [resolved], files, errors };
}

// --------- Auto-open ---------
// A directory can be passed as a CLI argument (packaged app) or via the
// PHOTO_SLAP_DIR env var (dev, where electron's argv is taken by vite).
function findDirectoryInArgs(args: string[]): string | null {
  for (const candidate of args) {
    if (!candidate || candidate.startsWith('-')) continue;
    try {
      if (statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch {
      // not a path — ignore
    }
  }
  return null;
}

function resolveAutoOpenDir(): string | null {
  return findDirectoryInArgs([
    ...process.argv.slice(app.isPackaged ? 1 : 2),
    process.env.PHOTO_SLAP_DIR ?? '',
  ]);
}

// --------- Single instance ---------
// A second launch focuses the existing window; if it was given a directory,
// that directory opens in the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', async (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const dir = findDirectoryInArgs(argv.slice(1));
  if (dir && win) {
    win.webContents.send('app:openScan', await scanAndAllow(dir));
  }
});

// Expose the Chrome DevTools Protocol when explicitly requested (automation/debugging)
if (process.env.PHOTO_SLAP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PHOTO_SLAP_DEBUG_PORT);
}

let win: BrowserWindow | null = null

// Move the slideshow fullscreen onto a given display. This is the "cast to
// TV" path: connect the TV via macOS Screen Mirroring (as an extended
// display) and it shows up here. Electron cannot initiate AirPlay streaming
// itself — that API is Safari/AVKit-only.
function sendToDisplay(displayId: number) {
  if (!win) return;
  const display = screen.getAllDisplays().find(d => d.id === displayId);
  if (!display) return;

  const move = () => {
    win?.setBounds(display.bounds);
    win?.setFullScreen(true);
  };

  if (win.isFullScreen()) {
    // Leave fullscreen on the current display first; the transition is
    // animated on macOS, so wait for it before moving.
    win.once('leave-full-screen', () => setTimeout(move, 150));
    win.setFullScreen(false);
  } else {
    move();
  }
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin'

  // Renderer-handled shortcuts, surfaced in the menu so they're
  // discoverable. registerAccelerator: false (macOS) shows the key without
  // registering it — the renderer's keydown handler stays the one owner.
  const action = (label: string, accelerator: string, name: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => win?.webContents.send('menu:action', name),
  });

  const displayItems: MenuItemConstructorOptions[] = screen.getAllDisplays().map((d, i) => ({
    label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
    click: () => sendToDisplay(d.id),
  }));

  const template: MenuItemConstructorOptions[] = [
    // { role: 'appMenu' }
    ...(isMac
      ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }] as MenuItemConstructorOptions[]
      : []),
    // { role: 'fileMenu' }
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            win?.webContents.send('menu:open-directory');
          }
        },
        {
          label: 'Show in Finder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            win?.webContents.send('menu:show-in-finder');
          }
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            win?.webContents.send('menu:open-settings');
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ] as MenuItemConstructorOptions[]
    },
    // All slideshow shortcuts, discoverable in one place
    {
      label: 'Actions',
      submenu: [
        action('Next Slide', 'Right', 'next'),
        action('Previous Slide', 'Left', 'prev'),
        action('Play / Pause Slideshow', 'Space', 'toggle-play'),
        action('Grid View', 'G', 'grid'),
        { type: 'separator' },
        action('Video: Skip Forward 10s', 'M', 'seek-forward'),
        action('Video: Skip Back 10s', 'N', 'seek-back'),
        { type: 'separator' },
        action('Reveal in Finder', 'F', 'reveal'),
        action('Move File to Trash', 'Backspace', 'delete'),
      ]
    },
    // { role: 'viewMenu' }
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ] as MenuItemConstructorOptions[]
    },
    // { role: 'windowMenu' }
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        {
          label: 'Send to Display',
          submenu: displayItems,
        },
        ...(isMac
          ? [
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' }
          ]
          : [
            { role: 'close' }
          ])
      ] as MenuItemConstructorOptions[]
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const iconPath = path.join(process.env.VITE_PUBLIC, 'icon.png');

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'photo-slap',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // A slideshow keeps playing while occluded (e.g. shown on a TV via
      // Send to Display); don't let Chromium throttle timers/animations.
      backgroundThrottling: false,
    },
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window', // macos blur effect
    visualEffectState: 'active',
  })

  // Set dock icon explicitly for macOS dev
  if (process.platform === 'darwin' && VITE_DEV_SERVER_URL) {
    app.dock?.setIcon(iconPath);
  }

  buildApplicationMenu();

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// IPC Handlers
ipcMain.handle('dialog:openDirectory', async () => {
  if (!win) return null;

  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'multiSelections']
  });

  if (result.canceled) {

    return null;
  }

  const allFiles: Awaited<ReturnType<typeof scanDirectory>>['files'] = [];
  const allErrors: string[] = [];
  for (const dirPath of result.filePaths) {
    allowedRoots.add(path.normalize(dirPath)); // permit media:// to serve from here
    const { files, errors } = await scanDirectory(dirPath);
    allFiles.push(...files);
    allErrors.push(...errors);
  }

  return { paths: result.filePaths, files: allFiles, errors: allErrors };
});

// Renderer asks on startup whether a directory was passed on launch
ipcMain.handle('app:getAutoOpen', async () => {
  const dir = resolveAutoOpenDir();
  return dir ? await scanAndAllow(dir) : null;
});

// Pick a directory without scanning it (used by the duplicate finder,
// which does its own scans). Registers it with media:// for previews.
ipcMain.handle('dialog:pickDirectory', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = path.resolve(result.filePaths[0]);
  allowedRoots.add(path.normalize(dir));
  return dir;
});

// Scan an arbitrary directory (drag-and-drop, "resume last folder")
ipcMain.handle('dir:scan', async (_event, dirPath: string) => {
  try {
    if (!statSync(dirPath).isDirectory()) return null;
  } catch {
    return null;
  }
  return await scanAndAllow(dirPath);
});

ipcMain.handle('file:delete', async (_event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return true;
  } catch (e) {
    console.error('Failed to delete file', e);
    return false;
  }
});

// Quick-move: relocate a file into one of the configured target folders
ipcMain.handle('file:move', async (_event, filePath: string, destDir: string) => {
  try {
    const dest = path.join(destDir, path.basename(filePath));
    try {
      await fs.access(dest);
      return { ok: false, error: 'A file with that name already exists there' };
    } catch {
      // destination free
    }
    try {
      await fs.rename(filePath, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
        // cross-volume move
        await fs.copyFile(filePath, dest);
        await fs.unlink(filePath);
      } else {
        throw e;
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('Failed to move file', e);
    return { ok: false, error: (e as Error).message };
  }
});

// Keep the display awake while a slideshow or video is playing
let powerBlockerId: number | null = null;
ipcMain.handle('power:setBlocked', (_event, blocked: boolean) => {
  if (blocked && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!blocked && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
});

ipcMain.handle('file:showInFolder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('store:get', (_event, key) => {
  return store.get(key);
});

ipcMain.handle('store:set', (_event, key, value) => {
  store.set(key, value);
});

ipcMain.handle('dedupe:scan:exact', async (_event, dirPaths: string[], includeVideos: boolean = true) => {
  return await findExactDuplicates(dirPaths, includeVideos);
});

ipcMain.handle('dedupe:scan:files', async (_event, dirPaths: string[], kind: 'images' | 'videos' = 'images') => {
  return await scanFiles(dirPaths, kind);
});

// Basic file stats for the dedupe compare cards
ipcMain.handle('files:getInfo', async (_event, paths: string[]) => {
  const result: Record<string, { size: number; mtimeMs: number }> = {};
  await Promise.all(paths.map(async (p) => {
    try {
      const stat = await fs.stat(p);
      result[p] = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // unreadable — leave out
    }
  }));
  return result;
});

// --------- Date-taken lookup (for date sorting) ---------
// EXIF dates live near the start of the file, so only the first 256 KB is
// read; anything without a parseable DateTimeOriginal falls back to mtime.
const EXIF_DATE_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

async function getFileDate(filePath: string): Promise<number> {
  let mtime = 0;
  try {
    mtime = (await fs.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }

  if (!/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(filePath)) return mtime;

  try {
    const fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const tags = ExifReader.load(buf.subarray(0, bytesRead));
    const raw = tags['DateTimeOriginal']?.description || tags['CreateDate']?.description;
    const m = raw && EXIF_DATE_RE.exec(String(raw));
    if (m) {
      const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
  } catch {
    // truncated/absent EXIF — fall back to mtime
  }
  return mtime;
}

ipcMain.handle('files:getDates', async (_event, paths: string[]) => {
  const result: Record<string, number> = {};
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      result[p] = await getFileDate(p);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return result;
});

ipcMain.handle('file:getExif', async (_event, filePath) => {
  try {
    const fileBuffer = await fs.readFile(filePath);
    const tags = await ExifReader.load(fileBuffer);
    // console.log('EXIF Tags for', filePath, Object.keys(tags)); // Debug log

    // Helper to get clean string
    const getString = (tag: any) => {
      if (!tag) return '';
      if (tag.description) return tag.description;
      if (tag.value) return Array.isArray(tag.value) ? tag.value.join(' ') : tag.value;
      return '';
    }

    const data = {
      make: getString(tags['Make']),
      model: getString(tags['Model']),
      lens: getString(tags['LensModel']) || getString(tags['Lens']) || getString(tags['LensInfo']),
      iso: getString(tags['ISOSpeedRatings']) || getString(tags['ISO']),
      aperture: getString(tags['FNumber']) || getString(tags['ApertureValue']),
      shutter: getString(tags['ExposureTime']) || getString(tags['ShutterSpeedValue']),
      focalLength: getString(tags['FocalLength']),
      date: getString(tags['DateTimeOriginal']) || getString(tags['CreateDate']),
    };

    // Only return if we have at least some data
    const hasData = Object.values(data).some(val => val !== '');
    return hasData ? data : null;
  } catch (e) {
    console.warn(`Failed to read EXIF for ${filePath}`, e);
    return null;
  }
});


// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  protocol.handle('media', handleMediaRequest);

  try {
    heicCacheDir = path.join(app.getPath('userData'), 'heic-cache');
    await fs.mkdir(heicCacheDir, { recursive: true });
  } catch {
    heicCacheDir = null; // cache disabled, transcoding still works
  }

  createWindow();

  // Keep the "Send to Display" submenu in sync as displays (e.g. an
  // AirPlay-mirrored TV) come and go.
  screen.on('display-added', buildApplicationMenu);
  screen.on('display-removed', buildApplicationMenu);
});

import { app, BrowserWindow, ipcMain, dialog, shell, net, protocol, Menu, MenuItemConstructorOptions } from 'electron'

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
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
      const buffer = await fs.readFile(filePath);
      const { width, height, data } = await decodeHeic({ buffer });
      const jpeg = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
        .jpeg({ quality: 90 })
        .toBuffer();
      return new Response(new Uint8Array(jpeg), {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600', ...MEDIA_CORS },
      });
    } catch (e) {
      console.error(`Failed to transcode ${filePath}`, e);
      return new Response('Decode failed', { status: 500, headers: MEDIA_CORS });
    }
  }

  const res = await net.fetch(pathToFileURL(filePath).toString());
  const headers = new Headers(res.headers);
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
    },
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window', // macos blur effect
    visualEffectState: 'active',
  })

  // Set dock icon explicitly for macOS dev
  if (process.platform === 'darwin' && VITE_DEV_SERVER_URL) {
    app.dock?.setIcon(iconPath);
  }

  // Create Menu
  const isMac = process.platform === 'darwin'

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

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

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

ipcMain.handle('file:showInFolder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('store:get', (_event, key) => {
  return store.get(key);
});

ipcMain.handle('store:set', (_event, key, value) => {
  store.set(key, value);
});

ipcMain.handle('dedupe:scan:exact', async (_event, dirPath) => {
  return await findExactDuplicates(dirPath);
});

ipcMain.handle('dedupe:scan:files', async (_event, dirPath) => {
  return await scanFiles(dirPath);
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

app.whenReady().then(() => {
  protocol.handle('media', handleMediaRequest);
  createWindow();
});

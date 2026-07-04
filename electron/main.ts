import { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItemConstructorOptions } from 'electron'

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import Store from 'electron-store'
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

// Define File Access
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

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
      webSecurity: false, // Required to load local files via file:// protocol
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

  const allFiles = [];
  for (const dirPath of result.filePaths) {

    const files = await scanDirectory(dirPath);
    allFiles.push(...files);
  }

  return { paths: result.filePaths, files: allFiles };
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
  createWindow();
});

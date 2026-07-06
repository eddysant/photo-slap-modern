import { ipcRenderer, contextBridge, webUtils } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('api', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  getAutoOpen: () => ipcRenderer.invoke('app:getAutoOpen'),
  scanPath: (path: string) => ipcRenderer.invoke('dir:scan', path),
  // Dropped File objects no longer carry .path; this resolves it
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getDates: (paths: string[]) => ipcRenderer.invoke('files:getDates', paths),
  deleteFile: (path: string) => ipcRenderer.invoke('file:delete', path),
  getStore: (key: string) => ipcRenderer.invoke('store:get', key),
  setStore: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  moveFile: (path: string, destDir: string) => ipcRenderer.invoke('file:move', path, destDir),
  setPowerBlocked: (blocked: boolean) => ipcRenderer.invoke('power:setBlocked', blocked),
  // Dedupe
  scanDedupeExact: (dirs: string[], includeVideos: boolean) => ipcRenderer.invoke('dedupe:scan:exact', dirs, includeVideos),
  scanDedupeFiles: (dirs: string[], kind: 'images' | 'videos') => ipcRenderer.invoke('dedupe:scan:files', dirs, kind),
  getFileInfo: (paths: string[]) => ipcRenderer.invoke('files:getInfo', paths),
  showInFolder: (path: string) => ipcRenderer.invoke('file:showInFolder', path),
  getExif: (path: string) => ipcRenderer.invoke('file:getExif', path),
})


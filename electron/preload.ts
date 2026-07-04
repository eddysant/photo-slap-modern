import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('api', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  getAutoOpen: () => ipcRenderer.invoke('app:getAutoOpen'),
  deleteFile: (path: string) => ipcRenderer.invoke('file:delete', path),
  getStore: (key: string) => ipcRenderer.invoke('store:get', key),
  setStore: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
  on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Dedupe
  scanDedupeExact: (dir: string) => ipcRenderer.invoke('dedupe:scan:exact', dir),
  scanDedupeFiles: (dir: string) => ipcRenderer.invoke('dedupe:scan:files', dir),
  showInFolder: (path: string) => ipcRenderer.invoke('file:showInFolder', path),
  getExif: (path: string) => ipcRenderer.invoke('file:getExif', path),
})


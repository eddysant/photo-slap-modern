/// <reference types="vite/client" />

interface MediaFile {
    name: string;
    path: string;
    type: 'image' | 'video';
}

interface ExifData {
    make: string;
    model: string;
    lens: string;
    iso: string;
    aperture: string;
    shutter: string;
    focalLength: string;
    date: string;
}

interface ScanResult {
    paths: string[];
    files: MediaFile[];
    errors: string[];
}

interface LibraryMeta {
    favorites: string[];
    tags: Record<string, string[]>;
    tagNames: string[];
}

interface Window {
    api: {
        openDirectory: () => Promise<ScanResult | null>;
        pickDirectory: () => Promise<string | null>;
        getAutoOpen: () => Promise<ScanResult | null>;
        scanPath: (path: string) => Promise<ScanResult | null>;
        getPathForFile: (file: File) => string;
        getDates: (paths: string[]) => Promise<Record<string, number>>;
        deleteFile: (path: string) => Promise<boolean>;
        getStore: (key: string) => Promise<any>;
        setStore: (key: string, value: any) => Promise<void>;
        showInFolder: (path: string) => Promise<void>;
        getExif: (path: string) => Promise<ExifData | null>;
        moveFile: (path: string, destDir: string) => Promise<{ ok: boolean; error?: string }>;
        libraryLoad: (roots: string[]) => Promise<LibraryMeta>;
        librarySave: (roots: string[], meta: LibraryMeta) => Promise<void>;
        setRemoteEnabled: (enabled: boolean) => Promise<string | null>;
        sendRemoteStatus: (status: {
            name: string | null; index: number | null; total: number;
            playing: boolean; favorite: boolean;
            path: string | null; root: string | null;
        }) => void;
        setPowerBlocked: (blocked: boolean) => Promise<void>;
        scanDedupeExact: (dirs: string[], includeVideos: boolean) => Promise<{ hash: string; files: string[] }[]>;
        scanDedupeFiles: (dirs: string[], kind: 'images' | 'videos') => Promise<string[]>;
        getFileInfo: (paths: string[]) => Promise<Record<string, { size: number; mtimeMs: number }>>;
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => () => void;
    }
}

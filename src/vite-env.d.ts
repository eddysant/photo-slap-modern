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
        scanDedupeExact: (dir: string) => Promise<{ hash: string; files: string[] }[]>;
        scanDedupeFiles: (dir: string) => Promise<string[]>;
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => () => void;
    }
}

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

interface Window {
    api: {
        openDirectory: () => Promise<{ paths: string[], files: MediaFile[] } | null>;
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

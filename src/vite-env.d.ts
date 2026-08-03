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
    ratings: Record<string, number>;
    culling: Record<string, CullingDecision>;
}

type CullingDecision = 'keep' | 'reject';

type LibraryHealthCategory = 'corrupt' | 'tiny' | 'unsupported' | 'missing-date' | 'orphan-sidecar';
type LibraryHealthRepairAction = 'remove-orphans' | 'quarantine-corrupt';

interface LibraryHealthIssue {
    category: LibraryHealthCategory;
    path: string;
    detail: string;
}

interface LibraryHealthReport {
    roots: string[];
    scannedFiles: number;
    issues: LibraryHealthIssue[];
    summary: Record<LibraryHealthCategory, number>;
}

interface QuarantinedFile {
    source: string;
    destination: string;
}

interface QuarantineEntry {
    root: string;
    originalPath: string;
    quarantinePath: string;
    size: number;
    quarantinedAt: string | null;
}

interface RestoredQuarantineFile {
    quarantinePath: string;
    restoredPath: string;
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
        scanLibraryHealth: (roots: string[]) => Promise<LibraryHealthReport>;
        repairLibraryHealth: (
            roots: string[],
            action: 'remove-orphans' | 'quarantine-corrupt',
            paths?: string[],
        ) => Promise<{ removed: string[]; quarantined: QuarantinedFile[] }>;
        exportLibraryHealth: (report: LibraryHealthReport) => Promise<string | null>;
        listQuarantine: (roots: string[]) => Promise<QuarantineEntry[]>;
        restoreQuarantine: (roots: string[], paths: string[]) => Promise<RestoredQuarantineFile[]>;
        deleteQuarantine: (roots: string[], paths: string[]) => Promise<string[]>;
        exportQuarantine: (roots: string[]) => Promise<string | null>;
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

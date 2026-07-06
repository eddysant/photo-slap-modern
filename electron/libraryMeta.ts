import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'fast-glob';

/**
 * Favorites and tags live WITH the photo library, not in app storage:
 * a `.photo-slap.json` sidecar at each opened root, holding paths relative
 * to its own directory (so the folder can move wholesale).
 *
 * Opening a parent folder picks up sidecars left in subfolders (from when
 * those were opened as roots themselves) and merges them. Each path is
 * "owned" by the deepest sidecar directory containing it — loads let
 * shallower sidecars override deeper ones per path, and saves write every
 * entry back to its owning sidecar, so entries don't duplicate or resurrect.
 */

export const SIDECAR_NAME = '.photo-slap.json';

export interface LibraryMeta {
    /** Absolute paths of favorited files. */
    favorites: string[];
    /** Absolute path → tags on that file. */
    tags: Record<string, string[]>;
    /** The tag vocabulary (quick-pick list), shared across the library. */
    tagNames: string[];
}

interface SidecarData {
    version: 1;
    favorites?: string[];
    tags?: Record<string, string[]>;
    tagNames?: string[];
}

export interface Sidecar {
    dir: string;
    data: SidecarData;
}

/** Merge sidecars; for a path claimed by several, the shallowest dir wins. */
export function mergeSidecars(sidecars: Sidecar[]): LibraryMeta {
    // Deepest first, so shallower assignments overwrite
    const sorted = [...sidecars].sort((a, b) => b.dir.length - a.dir.length);

    const favoriteByPath = new Map<string, boolean>();
    const tags: Record<string, string[]> = {};
    const tagNames = new Set<string>();

    for (const { dir, data } of sorted) {
        for (const rel of data.favorites ?? []) {
            favoriteByPath.set(path.resolve(dir, rel), true);
        }
        for (const [rel, fileTags] of Object.entries(data.tags ?? {})) {
            tags[path.resolve(dir, rel)] = fileTags;
        }
        for (const name of data.tagNames ?? []) tagNames.add(name);
    }

    return {
        favorites: [...favoriteByPath.keys()].sort(),
        tags,
        tagNames: [...tagNames].sort(),
    };
}

async function findSidecarFiles(root: string): Promise<string[]> {
    const nested = await glob(`**/${SIDECAR_NAME}`, {
        cwd: path.resolve(root).replace(/\\/g, '/'),
        absolute: true,
        onlyFiles: true,
        dot: true,
    });
    return nested.map(p => path.normalize(p));
}

async function readSidecar(file: string): Promise<Sidecar | null> {
    try {
        const data = JSON.parse(await fs.readFile(file, 'utf8')) as SidecarData;
        return { dir: path.dirname(file), data };
    } catch {
        return null; // missing or malformed — ignore
    }
}

export async function loadLibraryMeta(roots: string[]): Promise<LibraryMeta> {
    const files = new Set<string>();
    for (const root of roots) {
        for (const f of await findSidecarFiles(root)) files.add(f);
    }
    const sidecars = (await Promise.all([...files].map(readSidecar)))
        .filter((s): s is Sidecar => s !== null);
    return mergeSidecars(sidecars);
}

const isUnder = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);

export async function saveLibraryMeta(roots: string[], meta: LibraryMeta): Promise<void> {
    for (const root of roots) {
        const resolvedRoot = path.resolve(root);
        const existingFiles = await findSidecarFiles(resolvedRoot);
        // Ownership candidates: every existing sidecar dir plus the root,
        // deepest first so entries stay in the most specific file.
        const dirs = [...new Set([...existingFiles.map(f => path.dirname(f)), resolvedRoot])]
            .sort((a, b) => b.length - a.length);
        const ownerOf = (p: string) => dirs.find(d => isUnder(d, p)) ?? resolvedRoot;

        const buckets = new Map<string, { favorites: string[]; tags: Record<string, string[]> }>();
        const bucketFor = (dir: string) => {
            if (!buckets.has(dir)) buckets.set(dir, { favorites: [], tags: {} });
            return buckets.get(dir)!;
        };

        for (const fav of meta.favorites) {
            if (!isUnder(resolvedRoot, fav)) continue; // belongs to another root
            const dir = ownerOf(fav);
            bucketFor(dir).favorites.push(path.relative(dir, fav));
        }
        for (const [filePath, fileTags] of Object.entries(meta.tags)) {
            if (!isUnder(resolvedRoot, filePath) || fileTags.length === 0) continue;
            const dir = ownerOf(filePath);
            bucketFor(dir).tags[path.relative(dir, filePath)] = fileTags;
        }

        const existingDirs = new Set(existingFiles.map(f => path.dirname(f)));
        for (const dir of dirs) {
            const bucket = buckets.get(dir);
            const hasContent = !!bucket && (bucket.favorites.length > 0 || Object.keys(bucket.tags).length > 0);
            // Don't litter folders with empty sidecars; but rewrite existing
            // ones even when emptied so unfavorites/untags actually persist.
            if (!hasContent && !existingDirs.has(dir)) continue;

            const data: SidecarData = {
                version: 1,
                favorites: (bucket?.favorites ?? []).sort(),
                tags: bucket?.tags ?? {},
                tagNames: [...meta.tagNames].sort(),
            };
            await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify(data, null, 2));
        }
    }
}

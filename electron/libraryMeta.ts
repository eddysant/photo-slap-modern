import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'fast-glob';
import { isWithin } from './pathAccess';

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

export type CullingDecision = 'keep' | 'reject';

export interface LibraryMeta {
    /** Absolute paths of favorited files. */
    favorites: string[];
    /** Absolute path → tags on that file. */
    tags: Record<string, string[]>;
    /** The tag vocabulary (quick-pick list), shared across the library. */
    tagNames: string[];
    /** Absolute path → 1–5 star rating. */
    ratings: Record<string, number>;
    /** Absolute path → culling decision; absent means unreviewed. */
    culling: Record<string, CullingDecision>;
}

interface SidecarData {
    version: 1;
    favorites?: string[];
    tags?: Record<string, string[]>;
    tagNames?: string[];
    ratings?: Record<string, number>;
    culling?: Record<string, CullingDecision>;
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
    const ratings: Record<string, number> = {};
    const culling: Record<string, CullingDecision> = {};

    for (const { dir, data } of sorted) {
        for (const rel of data.favorites ?? []) {
            favoriteByPath.set(path.resolve(dir, rel), true);
        }
        for (const [rel, fileTags] of Object.entries(data.tags ?? {})) {
            tags[path.resolve(dir, rel)] = fileTags;
        }
        for (const name of data.tagNames ?? []) tagNames.add(name);
        for (const [rel, rating] of Object.entries(data.ratings ?? {})) {
            if (Number.isInteger(rating) && rating >= 1 && rating <= 5) ratings[path.resolve(dir, rel)] = rating;
        }
        for (const [rel, decision] of Object.entries(data.culling ?? {})) {
            if (decision === 'keep' || decision === 'reject') culling[path.resolve(dir, rel)] = decision;
        }
    }

    return {
        favorites: [...favoriteByPath.keys()].sort(),
        tags,
        tagNames: [...tagNames].sort(),
        ratings,
        culling,
    };
}

/**
 * Which directories under a root hold a sidecar, remembered per root.
 *
 * Finding them means a `**` walk, which has to list *every* directory in the
 * tree — the cost tracks directory count, not file count. Measured on 2,160
 * files across 240 directories on a local SSD: 4.2ms of a 5.7ms save, and
 * the save runs on an 800ms debounce as hearts and tags are pressed. On a
 * network volume every one of those listings is a round trip.
 *
 * The cache is refreshed by `loadLibraryMeta`, which is to say whenever a
 * library is opened, and updated by `saveLibraryMeta` when it creates a
 * sidecar. So the staleness it admits is exactly this: a sidecar that
 * appears from *outside* the app mid-session is not noticed until the next
 * load. That costs a deeper sidecar's entry being written to a shallower one
 * instead — which still loads back correctly, since merging is
 * shallowest-wins — and nothing writes these files but photo-slap, of which
 * one instance runs at a time (see the single-writer note under Sidecars).
 */
const sidecarDirsByRoot = new Map<string, Set<string>>();

async function findSidecarFiles(root: string): Promise<string[]> {
    const resolved = path.resolve(root);
    const nested = await glob(`**/${SIDECAR_NAME}`, {
        cwd: resolved.replace(/\\/g, '/'),
        absolute: true,
        onlyFiles: true,
        dot: true,
    });
    const files = nested.map(p => path.normalize(p));
    sidecarDirsByRoot.set(resolved, new Set(files.map(f => path.dirname(f))));
    return files;
}

/** The known sidecar dirs, walking the tree only if nothing knows yet. */
async function sidecarDirsFor(resolvedRoot: string): Promise<Set<string>> {
    const known = sidecarDirsByRoot.get(resolvedRoot);
    if (known) return known;
    await findSidecarFiles(resolvedRoot);
    return sidecarDirsByRoot.get(resolvedRoot) ?? new Set();
}

/**
 * Record a sidecar against every root that contains it, not just the one
 * being saved. A subfolder opened as a root of its own gets a sidecar under
 * that key, and a parent root open at the same time has to learn about it
 * too — otherwise the parent's next save would write the same entry into
 * its own shallower sidecar and the deeper one would be left behind.
 */
function rememberSidecarDir(dir: string): void {
    for (const [root, dirs] of sidecarDirsByRoot) {
        if (isWithin(root, dir) || root === dir) dirs.add(dir);
    }
}

/** The same, for a sidecar that has turned out not to exist any more. */
function forgetSidecarDir(dir: string): void {
    for (const dirs of sidecarDirsByRoot.values()) dirs.delete(dir);
}

/**
 * Forget what was discovered, so the next save walks the tree again. For
 * tests, and for anything that rearranges sidecars behind this module's
 * back.
 */
export function invalidateSidecarDirs(roots?: string[]): void {
    if (!roots) {
        sidecarDirsByRoot.clear();
        return;
    }
    for (const root of roots) sidecarDirsByRoot.delete(path.resolve(root));
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

export async function saveLibraryMeta(roots: string[], meta: LibraryMeta): Promise<void> {
    for (const root of roots) {
        const resolvedRoot = path.resolve(root);
        const knownDirs = await sidecarDirsFor(resolvedRoot);
        // Ownership candidates: every known sidecar dir plus the root,
        // deepest first so entries stay in the most specific file.
        const dirs = [...new Set([...knownDirs, resolvedRoot])]
            .sort((a, b) => b.length - a.length);
        const ownerOf = (p: string) => dirs.find(d => isWithin(d, p)) ?? resolvedRoot;

        const buckets = new Map<string, {
            favorites: string[];
            tags: Record<string, string[]>;
            ratings: Record<string, number>;
            culling: Record<string, CullingDecision>;
        }>();
        const bucketFor = (dir: string) => {
            if (!buckets.has(dir)) buckets.set(dir, { favorites: [], tags: {}, ratings: {}, culling: {} });
            return buckets.get(dir)!;
        };

        for (const fav of meta.favorites) {
            if (!isWithin(resolvedRoot, fav)) continue; // belongs to another root
            const dir = ownerOf(fav);
            bucketFor(dir).favorites.push(path.relative(dir, fav));
        }
        for (const [filePath, fileTags] of Object.entries(meta.tags)) {
            if (!isWithin(resolvedRoot, filePath) || fileTags.length === 0) continue;
            const dir = ownerOf(filePath);
            bucketFor(dir).tags[path.relative(dir, filePath)] = fileTags;
        }
        for (const [filePath, rating] of Object.entries(meta.ratings ?? {})) {
            if (!isWithin(resolvedRoot, filePath) || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
            const dir = ownerOf(filePath);
            bucketFor(dir).ratings[path.relative(dir, filePath)] = rating;
        }
        for (const [filePath, decision] of Object.entries(meta.culling ?? {})) {
            if (!isWithin(resolvedRoot, filePath) || (decision !== 'keep' && decision !== 'reject')) continue;
            const dir = ownerOf(filePath);
            bucketFor(dir).culling[path.relative(dir, filePath)] = decision;
        }

        // In parallel: these are distinct files, and one at a time cost
        // 3.8ms against 0.8ms on the same 240-directory library — the other
        // half of what a save was spending, and again a round trip each on a
        // network volume.
        await Promise.all(dirs.map(async dir => {
            const bucket = buckets.get(dir);
            const hasContent = !!bucket && (
                bucket.favorites.length > 0 || Object.keys(bucket.tags).length > 0 ||
                Object.keys(bucket.ratings).length > 0 || Object.keys(bucket.culling).length > 0
            );
            // Don't litter folders with empty sidecars; but rewrite existing
            // ones even when emptied so unfavorites/untags actually persist.
            //
            // Asked of the filesystem rather than of the cache. The cache
            // can believe in a sidecar the user has since deleted by hand,
            // and writing an empty one back would recreate a file they
            // removed. It is one `access` per emptied candidate, against the
            // tree walk this replaces.
            if (!hasContent) {
                if (!await pathExists(path.join(dir, SIDECAR_NAME))) {
                    forgetSidecarDir(dir);
                    return;
                }
            }

            const data: SidecarData = {
                version: 1,
                favorites: (bucket?.favorites ?? []).sort(),
                tags: bucket?.tags ?? {},
                tagNames: [...meta.tagNames].sort(),
                ratings: bucket?.ratings ?? {},
                culling: bucket?.culling ?? {},
            };
            await fs.writeFile(path.join(dir, SIDECAR_NAME), JSON.stringify(data, null, 2));
            // A sidecar this save created is one the next save must know
            // about, or the entries in it would migrate to a shallower file.
            rememberSidecarDir(dir);
        }));
    }
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Remove every metadata entry whose target no longer exists. */
export async function removeOrphanedLibraryMeta(roots: string[]): Promise<string[]> {
    const meta = await loadLibraryMeta(roots);
    const referenced = new Set([
        ...meta.favorites,
        ...Object.keys(meta.tags),
        ...Object.keys(meta.ratings),
        ...Object.keys(meta.culling),
    ]);
    const existing = new Set<string>();
    await Promise.all([...referenced].map(async filePath => {
        if (await pathExists(filePath)) existing.add(filePath);
    }));
    const removed = [...referenced].filter(filePath => !existing.has(filePath)).sort();
    if (removed.length === 0) return removed;

    await saveLibraryMeta(roots, {
        favorites: meta.favorites.filter(filePath => existing.has(filePath)),
        tags: Object.fromEntries(Object.entries(meta.tags).filter(([filePath]) => existing.has(filePath))),
        tagNames: meta.tagNames,
        ratings: Object.fromEntries(Object.entries(meta.ratings).filter(([filePath]) => existing.has(filePath))),
        culling: Object.fromEntries(Object.entries(meta.culling).filter(([filePath]) => existing.has(filePath))),
    });
    return removed;
}

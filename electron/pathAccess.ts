import path from 'node:path';

/**
 * The media:// protocol and the file IPC handlers both serve only files that
 * live inside directories the user explicitly opened (folder picker, CLI
 * argument, drag-and-drop, Resume). Roots accumulate here for the lifetime of
 * the process.
 *
 * This is the renderer/main trust boundary: the renderer is sandboxed
 * (contextIsolation, no node integration), but it still names paths, so every
 * handler that touches the filesystem checks them here rather than trusting
 * whatever string arrives over IPC.
 */
const allowedRoots = new Set<string>();

// macOS and Windows filesystems are case-insensitive by default, so a
// differently-cased request names the same file and must not 403.
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const forCompare = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/**
 * Exact containment: is `filePath` inside `dir`?
 *
 * Deliberately case-SENSITIVE, unlike `isAllowedPath` below. Callers use this
 * to decide which root *owns* a path and then take `path.relative()` against
 * that root — and a case-insensitive match between "/A/B" and "/a/b/c.jpg"
 * would produce a relative path of "../../a/b/c.jpg", corrupting sidecar and
 * quarantine entries. The security check can be lenient about case because it
 * only needs a yes/no; ownership cannot.
 *
 * The trailing separator is what stops "/lib-private" matching root "/lib".
 */
export function isWithin(dir: string, filePath: string): boolean {
    return filePath === dir || filePath.startsWith(dir + path.sep);
}

/** Permit reads/writes under `dir`. Returns the resolved root. */
export function allowRoot(dir: string): string {
    const resolved = path.resolve(dir);
    allowedRoots.add(resolved);
    return resolved;
}

export function isAllowedPath(filePath: string): boolean {
    if (!filePath) return false;
    // resolve() collapses ../ segments, so a traversal attempt is compared in
    // its real form rather than the literal string that was sent.
    const target = forCompare(path.resolve(filePath));
    for (const root of allowedRoots) {
        const candidate = forCompare(root);
        if (target === candidate || target.startsWith(candidate + path.sep)) return true;
    }
    return false;
}

/**
 * Resolve `filePath`, or throw if it sits outside every opened folder.
 * Returns the resolved path so callers use the normalized form.
 */
export function assertAllowedPath(filePath: string): string {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('A file path is required');
    }
    const resolved = path.resolve(filePath);
    if (!isAllowedPath(resolved)) {
        throw new Error('Path is outside the folders opened in photo-slap');
    }
    return resolved;
}

export function assertAllowedPaths(filePaths: string[]): string[] {
    if (!Array.isArray(filePaths)) throw new Error('A list of file paths is required');
    return filePaths.map(assertAllowedPath);
}

/**
 * Like assertAllowedPaths but for a batch where unreadable entries are
 * expected (stat lookups): drops disallowed paths instead of throwing, so one
 * stale path can't fail the whole request.
 */
export function filterAllowedPaths(filePaths: string[]): string[] {
    if (!Array.isArray(filePaths)) return [];
    return filePaths.filter(p => typeof p === 'string' && isAllowedPath(p)).map(p => path.resolve(p));
}

// media://local/Users/me/pic.jpg -> /Users/me/pic.jpg (or C:\... on Windows)
export function mediaUrlToPath(url: URL): string {
    let p = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:[/\\]/.test(p)) p = p.slice(1); // strip leading slash of Windows drive paths
    return path.normalize(p);
}

/** Test seam — clears the accumulated roots. */
export function __resetAllowedRoots(): void {
    allowedRoots.clear();
}

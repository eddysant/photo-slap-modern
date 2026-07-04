/**
 * Build a media:// URL for a local file. The main process serves these via a
 * custom protocol that only allows files inside user-opened directories
 * (and transcodes HEIC to JPEG). The "local" host is a required placeholder —
 * standard-scheme URLs must have a host or the first path segment would be
 * swallowed (and lowercased) as one.
 */
export function getFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    return `media://local${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

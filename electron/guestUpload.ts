import path from 'node:path';
import { SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS } from './fileScanner';

/**
 * Guest uploads arrive over the LAN remote from phones at a party. The
 * filename is attacker-controlled, so it is reduced to a bare, sanitized
 * basename with a whitelisted extension before it ever reaches the disk.
 */
/**
 * Derived from the scanner's list rather than written out again. The two had
 * drifted: uploads accepted `.mov`, which the scanner does not recognise, so
 * a guest's iPhone video joined the running show and then vanished from the
 * library on the next launch — with nothing to explain where it went.
 */
export const UPLOAD_EXTENSIONS = SUPPORTED_EXTENSIONS;

export type SanitizedUploadName =
    | { ok: true; safeName: string; stem: string; ext: string; type: 'image' | 'video' }
    | { ok: false; error: string };

/**
 * Strip any directory component, replace everything outside a conservative
 * character set, and require a whitelisted media extension.
 */
export function sanitizeUploadName(name: string): SanitizedUploadName {
    if (typeof name !== 'string' || name.trim().length === 0) {
        return { ok: false, error: 'Missing filename' };
    }

    // basename() drops "../" and absolute prefixes; the replace() then removes
    // anything that could still be meaningful to a shell or a filesystem.
    const stripped = path.basename(name).replace(/[^\w.\- ]+/g, '_');
    // A name that is only dots ("..", ".") would resolve to a directory.
    const safeName = /^\.+$/.test(stripped) ? '' : stripped;
    if (safeName.length === 0) return { ok: false, error: 'Invalid filename' };

    const ext = path.extname(safeName).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(ext)) return { ok: false, error: 'Unsupported file type' };

    const stem = safeName.slice(0, -ext.length);
    if (stem.length === 0) return { ok: false, error: 'Invalid filename' };

    return {
        ok: true,
        safeName,
        stem,
        ext,
        type: VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image',
    };
}

/**
 * First free name in `dir` for `stem+ext`, suffixing -1, -2, … on collision.
 * `exists` is injected so the collision walk is testable without a disk.
 */
export async function findFreeUploadPath(
    dir: string,
    stem: string,
    ext: string,
    exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
    let candidate = path.join(dir, `${stem}${ext}`);
    for (let n = 1; await exists(candidate); n++) {
        candidate = path.join(dir, `${stem}-${n}${ext}`);
    }
    return candidate;
}

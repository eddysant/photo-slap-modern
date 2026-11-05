import path from 'node:path';
import { VIDEO_EXTENSIONS } from './fileScanner';

/** How much of a file's head is read looking for EXIF. */
export const EXIF_HEAD_BYTES = 256 * 1024;

/**
 * The most of a file worth reading whole once its head carried no EXIF.
 *
 * The fallback exists for an image that trails its metadata past the head,
 * and it had no bound at all: `readFile` on whatever was asked for. Node
 * refuses above 2GiB, so a 3.4GB video failed loudly and cheaply — found by
 * pointing the app at a real Downloads folder. The reachable cost is the
 * file just under that limit, read entirely into the main process, which is
 * against the grain of everything else here. No photo carries EXIF past
 * 64MB; a video trailing nothing of the kind is the rest of what this stops.
 */
export const EXIF_WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

/**
 * Whether reading the rest of the file could tell us anything.
 *
 * A video is excluded by extension rather than by size: `exifreader` will
 * never find EXIF in one however much of it is read, and "no EXIF" is the
 * truthful answer for a video either way.
 */
export function shouldReadWholeFile(filePath: string, size: number): boolean {
    if (VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
    return size <= EXIF_WHOLE_FILE_LIMIT;
}

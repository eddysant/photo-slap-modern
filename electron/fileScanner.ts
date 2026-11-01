import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The formats the slideshow can actually play back. This is the authority:
 * anything not listed here will not be found by a re-scan, so it must not be
 * accepted from anywhere else either (see guestUpload.ts).
 */
/**
 * `.mov` and `.mkv` are here because they were measured, not assumed. They
 * were left out on the strength of `canPlayType`, which reports "no" for
 * `video/quicktime` — but that is advisory and, here, simply wrong:
 * served over a privileged scheme with `Content-Type: video/quicktime`,
 * exactly as media:// serves them, Electron 43 played H.264 .mov, HEVC .mov
 * and H.264 .mkv alike.
 *
 * What they do bring is files the decoder may refuse on some machines: HEVC
 * decode is hardware-dependent, and a .mkv can hold anything at all. That is
 * already handled — the `<video>` onError skip, the stall watchdog and the
 * health scan all exist for media that will not play. Refusing to look at an
 * iPhone video that would have played is the worse failure of the two.
 */
export const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.gifv', '.ogg', '.mov', '.mkv']);

export const SUPPORTED_EXTENSIONS = new Set([
  // Images (.heic/.heif are transcoded to JPEG by the media:// protocol)
  '.jpg', '.jpeg', '.webp', '.gif', '.png', '.bmp', '.heic', '.heif',
  ...VIDEO_EXTENSIONS,
]);

export interface MediaFile {
  name: string;
  path: string;
  type: 'image' | 'video';
}

export interface ScanResult {
  files: MediaFile[];
  /** Human-readable descriptions of directories that could not be read. */
  errors: string[];
}

export async function scanDirectory(dirPath: string): Promise<ScanResult> {
  const files: MediaFile[] = [];
  const errors: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
      errors.push(`${dir} (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`);
      return;
    }

    for (const entry of entries) {
      // Ignore dotfiles and system directories
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push({
            name: entry.name,
            path: fullPath,
            type: VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image',
          });
        }
      }
    }
  }

  await walk(dirPath);
  return { files, errors };
}

import fs from 'node:fs/promises';
import path from 'node:path';

const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.gifv', '.ogg']);

const SUPPORTED_EXTENSIONS = new Set([
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

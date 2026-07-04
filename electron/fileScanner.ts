import fs from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_EXTENSIONS = new Set([
  // Images
  '.jpg', '.jpeg', '.webp', '.gif', '.png', '.bmp',
  // Videos
  '.webm', '.mp4', '.gifv', '.ogg'
]);

export interface MediaFile {
  name: string;
  path: string;
  type: 'image' | 'video';
}

export async function scanDirectory(dirPath: string): Promise<MediaFile[]> {
  let results: MediaFile[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Ignore dotfiles and system directories
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const subResults = await scanDirectory(fullPath);
        results = results.concat(subResults);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          const isVideo = ['.webm', '.mp4', '.gifv', '.ogg'].includes(ext);

          results.push({
            name: entry.name,
            path: fullPath,
            type: isVideo ? 'video' : 'image'
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}:`, error);
  }


  return results;
}

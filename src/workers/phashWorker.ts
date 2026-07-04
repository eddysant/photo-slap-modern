import { bmvbhash } from 'blockhash-core';
import { getFileUrl } from '../utils';

// Perceptual hashing off the main thread: fetch each image over media://,
// decode, downscale to 16x16 on an OffscreenCanvas, and blockhash it.

export interface PHashRequest {
    paths: string[];
}

export type PHashMessage =
    | { type: 'progress'; done: number; total: number }
    | { type: 'done'; hashes: { path: string; hash: string }[] };

const post = (msg: PHashMessage) =>
    (self as unknown as { postMessage(m: PHashMessage): void }).postMessage(msg);

self.onmessage = async (e: MessageEvent<PHashRequest>) => {
    const { paths } = e.data;
    const hashes: { path: string; hash: string }[] = [];

    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        post({ type: 'done', hashes });
        return;
    }

    let done = 0;
    for (const filePath of paths) {
        try {
            const res = await fetch(getFileUrl(filePath));
            if (res.ok) {
                const bitmap = await createImageBitmap(await res.blob());
                ctx.drawImage(bitmap, 0, 0, 16, 16);
                bitmap.close();
                const imageData = ctx.getImageData(0, 0, 16, 16);
                hashes.push({ path: filePath, hash: bmvbhash(imageData, 16) });
            }
        } catch {
            // Unreadable or undecodable image — skip it.
        }
        done++;
        if (done % 10 === 0 || done === paths.length) {
            post({ type: 'progress', done, total: paths.length });
        }
    }

    post({ type: 'done', hashes });
};

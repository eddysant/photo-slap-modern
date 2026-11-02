import type decodeHeicType from 'heic-decode';
import { createConcurrencyLimit } from './concurrencyLimit';

/**
 * heic-decode is a WASM build of libheif + libde265 and costs ~12 MB of
 * resident memory the moment it is imported — before a single photo is
 * touched, and whether or not the library contains a single HEIC. Most do
 * not. Loading it on first use moves that cost onto the libraries that
 * actually need it, and the import is memoised so only the first HEIC pays
 * the instantiation.
 *
 * It is externalised in the bundler config, so this stays a real runtime
 * import rather than becoming a code-split chunk.
 */
let heicDecoder: Promise<typeof decodeHeicType> | null = null;

export function loadHeicDecoder(): Promise<typeof decodeHeicType> {
    heicDecoder ??= import('heic-decode').then(m => m.default);
    return heicDecoder;
}

/**
 * One HEIC decode at a time, everywhere in the main process.
 *
 * Measured on a 12MP HEIC: 24 decodes take 1650ms run one at a time and
 * 1572ms run eight at a time — inside the noise — for 448MB of peak RSS
 * against 821MB. The decoder is a single WASM instance that serialises on
 * the JS thread, so running several at once buys no parallelism whatever; it
 * only keeps more full-size RGBA buffers alive simultaneously, and a 12MP
 * HEIC decodes to 48MB of them.
 *
 * The gate lives here, around the decode itself, rather than at the call
 * sites, because there are three of them with different callers: the
 * media:// derive pipeline (capped at `DERIVE_CONCURRENCY`, which is tuned
 * for sharp — where concurrency genuinely buys 2.3x and must not be
 * lowered), the deep health scan (8 inspection workers), and the health
 * scan's dimension read. Each would otherwise need to know about this, and
 * one of them would eventually forget.
 */
const decodeGate = createConcurrencyLimit(1);

export async function decodeHeicImage(buffer: Buffer) {
    const decode = await loadHeicDecoder();
    return decodeGate(() => decode({ buffer }));
}

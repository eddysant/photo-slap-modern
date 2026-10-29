import type decodeHeicType from 'heic-decode';

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

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * heic-decode instantiates ~12 MB of WASM at import time, before a photo has
 * been looked at, and most libraries contain no HEIC at all. The saving is
 * only real while nothing in the main process pulls it in eagerly — a single
 * `import decodeHeic from 'heic-decode'` anywhere gives it all back, and
 * nothing else in the suite would notice.
 */
describe('the HEIC decoder is only loaded when a HEIC is touched', () => {
    const dir = path.join(import.meta.dirname, '../electron');
    const sources = fs.readdirSync(dir)
        .filter(name => name.endsWith('.ts'))
        .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));

    it('has sources to check', () => {
        expect(sources.length).toBeGreaterThan(5);
    });

    it('nothing in the main process statically imports heic-decode', () => {
        const offenders = sources
            // lazyDeps owns the dynamic import, and a `import type` is erased
            .filter(({ text }) => /^\s*import\s+(?!type\s)[^;]*from\s+['"]heic-decode['"]/m.test(text))
            .map(({ name }) => name);
        expect(offenders).toEqual([]);
    });

    /**
     * `lazyDeps.ts` is the only door. Everything else calls
     * `decodeHeicImage`, which is both lazy and serialised — a second
     * caller reaching the decoder directly would get its laziness from the
     * memoised loader and silently lose the concurrency gate, which is worth
     * ~370MB of peak RSS and no speed at all.
     */
    it('only lazyDeps touches the decoder itself', () => {
        const offenders = sources
            .filter(({ name }) => name !== 'lazyDeps.ts')
            .filter(({ text }) => /loadHeicDecoder\s*\(|\bdecodeHeic\s*\(/.test(text))
            .map(({ name }) => name);
        expect(offenders).toEqual([]);
    });

    it('and the rest of the main process decodes through the gated call', () => {
        const users = sources.filter(({ text }) => /\bdecodeHeicImage\s*\(/.test(text));
        // libraryHealth.ts calls it for dimensions and the deep scan.
        expect(users.map(u => u.name).sort()).toEqual(['lazyDeps.ts', 'libraryHealth.ts']);
    });

    /**
     * The media:// derive no longer calls the decoder by name: it lives in
     * `imageDeriver.ts`, which takes its decoder as an option so a test can
     * count the decodes. That makes "which function was it handed" the thing
     * to pin — an inline decoder built from the memoised loader would work,
     * stay lazy, and quietly run outside the gate.
     */
    it('and the deriver is handed the gated call, not a decoder of its own', () => {
        const main = sources.find(({ name }) => name === 'main.ts');
        expect(main?.text).toMatch(/decodeHeic:\s*decodeHeicImage\b/);
        const deriver = sources.find(({ name }) => name === 'imageDeriver.ts');
        expect(deriver?.text).toMatch(/options\.decodeHeic/);
        expect(deriver?.text).not.toMatch(/lazyDeps|heic-decode/);
    });

    /**
     * The decode is serialised because the WASM decoder gains nothing from
     * concurrency and costs a full-size RGBA buffer per caller. Measured: 24
     * decodes in 1650ms at one in flight against 1572ms at eight, for 448MB
     * against 821MB of peak RSS.
     */
    it('serialises the decode rather than merely memoising the import', () => {
        const lazy = sources.find(({ name }) => name === 'lazyDeps.ts');
        expect(lazy?.text).toMatch(/createConcurrencyLimit\(1\)/);
        // The gate has to wrap the decode, not sit beside it unused.
        const gated = /decodeGate\(\s*\(\)\s*=>\s*decode\(/.test(lazy?.text ?? '');
        expect(gated).toBe(true);
    });
});

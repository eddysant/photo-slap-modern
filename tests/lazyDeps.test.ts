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

    it('and every decode goes through the lazy loader', () => {
        const users = sources.filter(({ text }) => /\bdecodeHeic\s*\(/.test(text));
        expect(users.length).toBeGreaterThan(0);
        for (const { name, text } of users) {
            expect(text, name).toMatch(/loadHeicDecoder\(\)/);
        }
    });
});

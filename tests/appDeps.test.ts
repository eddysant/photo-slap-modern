import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the source: the effects in `App` that own the keydown handler and the
 * `menu:action` IPC listeners must not name a whole hook object in their
 * dependency arrays.
 *
 * Every engine hook returns a memoized object, but the memo is not the
 * guarantee — `useVideoElement`'s `progress` and `useSlideNavigation`'s
 * `direction` genuinely change, several times a second while a clip plays, so
 * the object's identity changes with them. A consumer has to name the
 * callbacks it uses. Naming `video` instead cost 21 re-registrations over 5s
 * of playback, which `scripts/e2e.mjs` measures and this test localises: the
 * e2e says the number is wrong, this says which identifier did it.
 */
describe('App does not make a hook object a dependency', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');

    /** The dependency arrays of the two listener-owning effects. */
    const listenerDeps = () => {
        const found: { what: string; deps: string }[] = [];
        for (const marker of ['window.addEventListener(\'keydown\'', 'window.api.on(\'menu:action\'']) {
            const at = source.indexOf(marker);
            expect(at, marker).toBeGreaterThan(-1);
            const close = source.indexOf('}, [', at);
            expect(close, marker).toBeGreaterThan(-1);
            found.push({ what: marker, deps: source.slice(close + 4, source.indexOf(']);', close)) });
        }
        return found;
    };

    it('finds both dependency arrays', () => {
        const deps = listenerDeps();
        expect(deps).toHaveLength(2);
        for (const { deps: list } of deps) expect(list).toContain('nextSlide');
    });

    it('names callbacks, not the objects they came from', () => {
        // The hook results as App binds them. A bare one of these in a
        // dependency array is the bug.
        const objects = ['video', 'nav', 'meta', 'shuffle', 'position', 'deletes', 'remote'];
        for (const { what, deps } of listenerDeps()) {
            const named = deps.split(',').map(d => d.trim()).filter(d => objects.includes(d));
            expect(named, `${what} names a whole hook object`).toEqual([]);
        }
    });

    /**
     * And the same object must not be reached through a member expression in
     * the effect body either: ESLint's exhaustive-deps then demands the whole
     * object, which is how this was reintroduced.
     */
    it('does not reach into a hook object from inside those effects', () => {
        for (const marker of ['window.addEventListener(\'keydown\'', 'window.api.on(\'menu:action\'']) {
            const at = source.indexOf(marker);
            // Back up to the start of the enclosing useEffect.
            const start = source.lastIndexOf('useEffect(() => {', at);
            const body = source.slice(start, source.indexOf('}, [', at));
            expect(body, marker).not.toMatch(/\b(video|nav)\.\w/);
        }
    });
});

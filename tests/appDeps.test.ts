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

/**
 * Reads the source: no dependency array anywhere in `App` names `shuffle`.
 *
 * The listener check above covers two effects; this one covers all of them,
 * for the object that did the most damage. `shuffle.progress` changes on
 * every slide, and the effect that records a view both listed `shuffle` and
 * reported progress — so it re-ran itself without end, ~10,000 times a
 * second, resetting the image timer each time: a shuffled show set to play
 * never moved. The hook now keeps its identity when progress has not changed,
 * and App names the stable callbacks instead. Either alone would have stopped
 * the loop; this keeps the second from regressing quietly.
 */
describe('App never depends on the whole shuffle object', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');
    const arrays = [...source.matchAll(/\}, \[([^\]]*)\]\)/g)].map(m => m[1]);

    it('finds the dependency arrays', () => {
        expect(arrays.length).toBeGreaterThan(20);
    });

    it('lists none that name it', () => {
        const offenders = arrays.filter(deps => deps.split(',').map(d => d.trim()).includes('shuffle'));
        expect(offenders).toEqual([]);
    });

    it('hands the navigation hook the stable callbacks, not the object', () => {
        expect(source).toMatch(/useSlideNavigation\(\{[\s\S]{0,200}shuffle: shuffleOps/);
    });
});

/**
 * Reads the source: a quick-move must not go through the delete path.
 *
 * `handleFilesDeleted` calls `meta.forget`, which prunes the file's favorite,
 * tags, rating and culling decision *and persists it*. That is right for a
 * file in the Trash and wrong for one the user filed into `Keep/` — the photo
 * still exists, usually inside the same library, so filing a hearted photo
 * away erased the heart and the sidecar write made it permanent. Both move
 * paths go through `handleFilesMoved`, which carries the metadata across.
 *
 * This is a source read because the alternative is rendering `App`, and the
 * loss is only observable one sidecar write later.
 */
describe('App treats a moved file as moved, not deleted', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');

    /** The body of a `const <name> = useCallback(...)` in App. */
    const body = (name: string) => {
        const at = source.indexOf(`const ${name} = useCallback(`);
        expect(at, name).toBeGreaterThan(-1);
        const end = source.indexOf('\n  }, [', at);
        expect(end, name).toBeGreaterThan(-1);
        return source.slice(at, end);
    };

    for (const mover of ['quickMove', 'batchMove']) {
        it(`${mover} does not forget the file's metadata`, () => {
            const source = body(mover);
            expect(source).toContain('handleFilesMoved');
            expect(source).not.toContain('handleFilesDeleted');
            expect(source).not.toContain('meta.forget');
        });
    }

    it('handleFilesMoved relocates the metadata rather than pruning it', () => {
        const moved = body('handleFilesMoved');
        expect(moved).toContain('meta.relocate');
        expect(moved).not.toContain('meta.forget');
    });

    // The counterpart, so this test cannot pass by `forget` having no callers.
    it('a real delete still forgets it', () => {
        expect(body('handleFilesDeleted')).toContain('meta.forget');
    });
});

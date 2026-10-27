import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    createSidecarSaver,
    pruneMetadata,
    sidecarAction,
    sidecarPayload,
    toggleTag,
    type LibraryMetaState,
    type MetadataStorage,
    type MetaSnapshot,
} from '../src/hooks/useLibraryMeta';

const state = (): LibraryMetaState => ({
    favorites: new Set(['/lib/a.jpg', '/lib/b.jpg']),
    fileTags: { '/lib/a.jpg': ['beach'], '/lib/b.jpg': ['dog'] },
    tagNames: ['beach', 'dog'],
    ratings: { '/lib/a.jpg': 5 },
    cullingDecisions: { '/lib/b.jpg': 'reject' },
});

describe('pruneMetadata', () => {
    it('removes a deleted file from every map', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg']);
        expect(next.favorites.has('/lib/a.jpg')).toBe(false);
        expect(next.fileTags['/lib/a.jpg']).toBeUndefined();
        expect(next.ratings['/lib/a.jpg']).toBeUndefined();
    });

    it('leaves other files untouched', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg']);
        expect(next.favorites.has('/lib/b.jpg')).toBe(true);
        expect(next.fileTags['/lib/b.jpg']).toEqual(['dog']);
        expect(next.cullingDecisions['/lib/b.jpg']).toBe('reject');
    });

    it('keeps the tag vocabulary — a tag outlives the photos using it', () => {
        const next = pruneMetadata(state(), ['/lib/a.jpg', '/lib/b.jpg']);
        expect(next.tagNames).toEqual(['beach', 'dog']);
    });

    it('returns the same object when nothing matched, so no save is scheduled', () => {
        const original = state();
        expect(pruneMetadata(original, [])).toBe(original);
        expect(pruneMetadata(original, ['/lib/never-existed.jpg'])).toBe(original);
    });
});

describe('toggleTag', () => {
    it('adds a tag that is not there', () => {
        expect(toggleTag({}, '/lib/a.jpg', 'beach')).toEqual({ '/lib/a.jpg': ['beach'] });
    });

    it('removes a tag that is', () => {
        const tags = { '/lib/a.jpg': ['beach', 'dog'] };
        expect(toggleTag(tags, '/lib/a.jpg', 'beach')).toEqual({ '/lib/a.jpg': ['dog'] });
    });

    it('drops the key entirely when the last tag is removed', () => {
        const result = toggleTag({ '/lib/a.jpg': ['beach'] }, '/lib/a.jpg', 'beach');
        expect('/lib/a.jpg' in result).toBe(false);
    });

    it('does not mutate the input', () => {
        const tags = { '/lib/a.jpg': ['beach'] };
        toggleTag(tags, '/lib/a.jpg', 'dog');
        expect(tags).toEqual({ '/lib/a.jpg': ['beach'] });
    });
});

describe('sidecarPayload', () => {
    it('writes the favorites set out as a list', () => {
        expect(sidecarPayload(state()).favorites).toEqual(['/lib/a.jpg', '/lib/b.jpg']);
    });

    it('carries every map through unchanged', () => {
        const payload = sidecarPayload(state());
        expect(payload.tags).toEqual({ '/lib/a.jpg': ['beach'], '/lib/b.jpg': ['dog'] });
        expect(payload.tagNames).toEqual(['beach', 'dog']);
        expect(payload.ratings).toEqual({ '/lib/a.jpg': 5 });
        expect(payload.culling).toEqual({ '/lib/b.jpg': 'reject' });
    });

    it('does not mutate the state it was given', () => {
        const original = state();
        sidecarPayload(original);
        expect(original.favorites).toBeInstanceOf(Set);
        expect(original.favorites.size).toBe(2);
    });
});

describe('sidecarAction', () => {
    it('schedules a write for an edit while saving to sidecars', () => {
        expect(sidecarAction({ kind: 'edit' }, 'sidecar')).toBe('schedule');
    });

    it('does nothing for an edit while in memory', () => {
        expect(sidecarAction({ kind: 'edit' }, 'memory')).toBe('none');
    });

    /**
     * Turning saving on means "save what I have" — the session's work is
     * already in memory and would otherwise sit there until the next edit.
     */
    it('writes immediately when sidecars are turned on', () => {
        expect(sidecarAction({ kind: 'storage-changed', from: 'memory' }, 'sidecar')).toBe('write-now');
    });

    it('cancels a queued write when sidecars are turned off', () => {
        expect(sidecarAction({ kind: 'storage-changed', from: 'sidecar' }, 'memory')).toBe('cancel');
    });

    it('ignores a change that changed nothing', () => {
        expect(sidecarAction({ kind: 'storage-changed', from: 'sidecar' }, 'sidecar')).toBe('none');
        expect(sidecarAction({ kind: 'storage-changed', from: 'memory' }, 'memory')).toBe('none');
    });
});

describe('createSidecarSaver', () => {
    const DELAY = 800;
    const ROOTS = ['/lib'];
    let writes: { roots: string[]; payload: LibraryMeta }[];
    let saver: ReturnType<typeof createSidecarSaver>;

    const snap = (overrides: Partial<MetaSnapshot> = {}): MetaSnapshot =>
        ({ state: state(), roots: ROOTS, ...overrides });

    const saverFor = (storage: MetadataStorage) =>
        createSidecarSaver((roots, payload) => writes.push({ roots, payload }), DELAY, storage);

    beforeEach(() => {
        vi.useFakeTimers();
        writes = [];
        saver = saverFor('sidecar');
    });

    afterEach(() => { vi.useRealTimers(); });

    it('starts in the mode it was given', () => {
        expect(saver.storage).toBe('sidecar');
        expect(saverFor('memory').storage).toBe('memory');
    });

    it('writes an edit once the debounce elapses', () => {
        saver.edit(snap());
        expect(writes).toHaveLength(0);
        vi.advanceTimersByTime(DELAY);
        expect(writes).toHaveLength(1);
        expect(writes[0].payload.favorites).toEqual(['/lib/a.jpg', '/lib/b.jpg']);
        expect(writes[0].roots).toEqual(ROOTS);
    });

    /**
     * The bug this pairing exists to prevent: an edit in one library, a
     * different library opened inside the debounce, and the write lands with
     * the first library's entries against the second library's roots. Every
     * entry belongs to neither root, so the buckets come out empty — and
     * `saveLibraryMeta` rewrites an existing sidecar even when emptied, so
     * unfavorites stick. The newly opened library is erased.
     */
    it('writes to the roots the edit was made in, not the ones open when it lands', () => {
        saver.edit(snap({ roots: ['/library-a'] }));
        // the user opens another library; a later snapshot would say /library-b
        vi.advanceTimersByTime(DELAY);
        expect(writes).toHaveLength(1);
        expect(writes[0].roots).toEqual(['/library-a']);
    });

    it('writes nothing when there are no roots to write to', () => {
        saver.edit(snap({ roots: [] }));
        vi.advanceTimersByTime(DELAY);
        expect(writes).toEqual([]);
    });

    it('coalesces a burst of edits into one write', () => {
        saver.edit(snap());
        vi.advanceTimersByTime(DELAY - 1);
        saver.edit(snap());
        vi.advanceTimersByTime(DELAY - 1);
        saver.edit(snap());
        vi.advanceTimersByTime(DELAY);
        expect(writes).toHaveLength(1);
    });

    it('writes the newest snapshot, not the one from the first edit', () => {
        saver.edit(snap());
        saver.edit(snap({ state: { ...state(), tagNames: ['beach', 'dog', 'sunset'] } }));
        vi.advanceTimersByTime(DELAY);
        expect(writes[0].payload.tagNames).toEqual(['beach', 'dog', 'sunset']);
    });

    /** The whole point of the setting: an edit must touch nothing on disk. */
    it('never writes while metadata is kept in memory', () => {
        const memory = saverFor('memory');
        memory.edit(snap());
        vi.advanceTimersByTime(DELAY * 10);
        expect(writes).toEqual([]);
        expect(memory.pending).toBe(false);
    });

    /**
     * The race the setting would otherwise lose: an edit queues a write, and
     * the user switches to memory a moment later. The write is already in
     * flight, and landing it would put a sidecar in a folder the user has
     * just asked to leave alone.
     */
    it('drops a write that was queued before sidecars were turned off', () => {
        saver.edit(snap());
        expect(saver.pending).toBe(true);
        saver.setStorage('memory', snap());
        vi.advanceTimersByTime(DELAY * 10);
        expect(writes).toEqual([]);
        expect(saver.pending).toBe(false);
    });

    it('keeps writing nothing for every edit after the switch', () => {
        saver.setStorage('memory', snap());
        saver.edit(snap());
        saver.edit(snap());
        vi.advanceTimersByTime(DELAY * 10);
        expect(writes).toEqual([]);
    });

    it('writes the session immediately when sidecars are turned on', () => {
        const memory = saverFor('memory');
        memory.edit(snap());
        memory.setStorage('sidecar', snap());
        expect(writes).toHaveLength(1);
        expect(memory.storage).toBe('sidecar');
    });

    it('does not write when the mode was set to what it already was', () => {
        saver.setStorage('sidecar', snap());
        expect(writes).toEqual([]);
    });

    /** Quitting inside the debounce used to lose the last heart press. */
    it('flushes a pending write on the way out', () => {
        saver.edit(snap());
        saver.flush(snap());
        expect(writes).toHaveLength(1);
        vi.advanceTimersByTime(DELAY * 10);
        expect(writes).toHaveLength(1);
    });

    it('flushes nothing when nothing is pending', () => {
        saver.flush(snap());
        expect(writes).toEqual([]);
    });

    /**
     * Nothing is ever pending in memory mode, so quitting cannot resurrect a
     * write the setting was meant to prevent. That is the invariant `flush`
     * relies on instead of re-checking the mode itself.
     */
    it('has nothing to flush while in memory', () => {
        const memory = saverFor('memory');
        memory.edit(snap());
        expect(memory.pending).toBe(false);
        memory.flush(snap());
        expect(writes).toEqual([]);
    });

    it('cancel leaves nothing pending', () => {
        saver.edit(snap());
        expect(saver.pending).toBe(true);
        saver.cancel();
        expect(saver.pending).toBe(false);
        vi.advanceTimersByTime(DELAY * 10);
        expect(writes).toEqual([]);
    });
});

/**
 * Reads the source. The saver tests above prove the write policy is obeyed —
 * but only for writes that go through the saver. "Don't write sidecars" is
 * worth nothing if a second call site appears somewhere else in the renderer,
 * so there is exactly one door and the saver is what opens it.
 */
describe('only one place in the renderer writes a sidecar', () => {
    const sources = fs.globSync('src/**/*.{ts,tsx}')
        .filter(file => !file.endsWith('vite-env.d.ts'))
        .map(file => [file, fs.readFileSync(file, 'utf8')] as const);

    it('found the renderer sources', () => {
        expect(sources.length).toBeGreaterThan(10);
    });

    it('calls window.api.librarySave from useLibraryMeta and nowhere else', () => {
        const callers = sources
            .filter(([, text]) => /window\.api\.librarySave\s*\(/.test(text))
            .map(([file]) => path.basename(file));
        expect(callers).toEqual(['useLibraryMeta.ts']);
    });

    /**
     * The policy is only worth as much as its wiring: a hook defaulting to
     * `'sidecar'` that nobody ever passes the setting to looks completely
     * correct and ignores the control the user just changed.
     */
    it('hands the setting to the hook that owns the write', () => {
        const app = fs.readFileSync('src/App.tsx', 'utf8');
        expect(app).toMatch(/useLibraryMeta\(currentDirs,\s*metadataStorage\)/);
        expect(app).toMatch(/usePersistedState<MetadataStorage>\('metadataStorage', 'sidecar'\)/);
    });

    it('does not reach the preload binding by another name', () => {
        const aliased = sources
            .filter(([file]) => !file.endsWith('useLibraryMeta.ts'))
            .filter(([, text]) => /librarySave/.test(text))
            .map(([file]) => path.basename(file));
        expect(aliased).toEqual([]);
    });
});

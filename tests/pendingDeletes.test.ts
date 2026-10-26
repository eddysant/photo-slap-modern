import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { trashFiles } from '../src/hooks/usePendingDeletes';

const file = (name: string) => ({ name, path: `/lib/${name}`, type: 'image' as const });

describe('trashFiles', () => {
    it('reports nothing when every file reaches the Trash', async () => {
        expect(await trashFiles([file('a.jpg'), file('b.jpg')], async () => true)).toEqual([]);
    });

    /**
     * A refusal is ordinary, not exceptional: an external drive formatted
     * exFAT has no `.Trashes`, so macOS declines every one of them. These are
     * the files the caller has to put back, because they are still on disk.
     */
    it('reports the files the Trash refused', async () => {
        const failed = await trashFiles(
            [file('a.jpg'), file('b.jpg'), file('c.jpg')],
            async p => !p.endsWith('b.jpg'),
        );
        expect(failed.map(f => f.name)).toEqual(['b.jpg']);
    });

    it('treats a thrown error as a refusal rather than losing the file', async () => {
        const failed = await trashFiles([file('a.jpg')], async () => { throw new Error('EPERM'); });
        expect(failed.map(f => f.name)).toEqual(['a.jpg']);
    });

    it('reports every file when the volume refuses them all', async () => {
        const all = [file('a.jpg'), file('b.jpg')];
        expect(await trashFiles(all, async () => false)).toEqual(all);
    });

    it('attempts them in order', async () => {
        const seen: string[] = [];
        await trashFiles([file('a.jpg'), file('b.jpg')], async p => { seen.push(p); return true; });
        expect(seen).toEqual(['/lib/a.jpg', '/lib/b.jpg']);
    });
});

/**
 * Reads the source: a restore that the user did not ask for has to be
 * distinguishable from an undo, or a photo the Trash refused reappears with
 * no explanation and looks exactly like a bug. It did, for one release.
 */
describe('every restore says why it happened', () => {
    const source = fs.readFileSync(
        path.join(import.meta.dirname, '../src/hooks/usePendingDeletes.ts'), 'utf8');
    const calls = [...source.matchAll(/onRestoredRef\.current\(([^)]*)\)/g)].map(m => m[1]);

    it('finds the restore call sites', () => {
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });

    it('passes a reason every time', () => {
        const withoutReason = calls.filter(args => !/,\s*'(undo|trash-failed)'/.test(args));
        expect(withoutReason).toEqual([]);
    });

    it('calls a failed trash a failed trash', () => {
        const failures = calls.filter(args => /failed/.test(args));
        expect(failures.length).toBeGreaterThanOrEqual(2);
        expect(failures.every(args => args.includes("'trash-failed'"))).toBe(true);
    });

    it('and App tells the user about one', () => {
        const app = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');
        expect(app).toMatch(/reason === 'trash-failed'/);
        expect(app).toMatch(/Couldn't move .*to the Trash/);
    });
});

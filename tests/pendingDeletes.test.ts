import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanTrashReason, trashFailureMessage, trashFiles } from '../src/hooks/usePendingDeletes';

const file = (name: string) => ({ name, path: `/lib/${name}`, type: 'image' as const });

describe('trashFiles', () => {
    it('reports nothing when every file reaches the Trash', async () => {
        expect(await trashFiles([file('a.jpg'), file('b.jpg')], async () => ({ ok: true }))).toEqual([]);
    });

    /**
     * A refusal is ordinary, not exceptional: an external drive formatted
     * exFAT has no `.Trashes`, so macOS declines every one of them. These are
     * the files the caller has to put back, because they are still on disk.
     */
    it('reports the files the Trash refused', async () => {
        const failed = await trashFiles(
            [file('a.jpg'), file('b.jpg'), file('c.jpg')],
            async p => p.endsWith('b.jpg')
                ? { ok: false, reason: 'Permission denied' }
                : { ok: true },
        );
        expect(failed.map(f => f.file.name)).toEqual(['b.jpg']);
        expect(failed[0].reason).toBe('Permission denied');
    });

    it('treats a thrown error as a refusal rather than losing the file', async () => {
        const failed = await trashFiles([file('a.jpg')], async () => { throw new Error('EPERM'); });
        expect(failed.map(f => f.file.name)).toEqual(['a.jpg']);
        // A thrown error still carries the only explanation there is.
        expect(failed[0].reason).toBe('EPERM');
    });

    it('reports every file when the volume refuses them all', async () => {
        const all = [file('a.jpg'), file('b.jpg')];
        const failed = await trashFiles(all, async () => ({ ok: false, reason: 'no Trash on this volume' }));
        expect(failed.map(f => f.file)).toEqual(all);
    });

    it('attempts them in order', async () => {
        const seen: string[] = [];
        await trashFiles([file('a.jpg'), file('b.jpg')], async p => { seen.push(p); return { ok: true }; });
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
    /**
     * Balanced-paren extraction, not `[^)]*`: a call site is allowed to
     * contain a call of its own (`failed.map(f => f.file)`), and a guard that
     * silently stopped at the first `)` reported the arguments as missing
     * rather than reporting nothing wrong — which is the failure mode a
     * drift guard must not have.
     */
    const argsAt = (from: number) => {
        let depth = 0;
        for (let i = from; i < source.length; i++) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')' && --depth === 0) return source.slice(from + 1, i);
        }
        return '';
    };
    const calls = [...source.matchAll(/onRestoredRef\.current(?=\()/g)]
        .map(m => argsAt(m.index + m[0].length));

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
        expect(app).toMatch(/trashFailureMessage\(restored, why\)/);
    });

    /**
     * The notice has to carry an action. `useToast` drops a plain message
     * arriving while an actionable toast still protects itself (pinned in
     * `tests/useToast.test.tsx`), and the delete's Undo toast is given
     * exactly the undo window — the same duration as the timer that fires
     * this notice. Carrying an action means its appearance does not depend
     * on which of two equal timers happens to run first.
     */
    it('gives the failure notice an action so the toast rule cannot drop it', () => {
        const app = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');
        const call = app.slice(app.indexOf('trashFailureMessage(restored, why)'));
        expect(call.slice(0, 240)).toMatch(/label: 'Reveal'/);
    });

    /**
     * Only an undo may move the viewer. Pinning the restored path on a
     * refusal dragged the show back to the photo the user had just tried to
     * delete, seven seconds after they moved on.
     */
    it('moves the viewer for an undo and not for a refusal', () => {
        const app = fs.readFileSync(path.join(import.meta.dirname, '../src/App.tsx'), 'utf8');
        const body = app.slice(app.indexOf('const restoreToView'), app.indexOf('const applyWatchChange'));
        expect(body).toMatch(/if \(reason === 'undo'\) pinPath/);
        expect(body).toMatch(/else hold\(\)/);
    });
});

describe('what the user is told when the Trash refuses a file', () => {
    it('names the file and says it is still in the show', () => {
        expect(trashFailureMessage([file('a.jpg')]))
            .toBe("Couldn't move a.jpg to the Trash. It's still in the show.");
    });

    it('carries the reason when there is one, because that is the actionable part', () => {
        expect(trashFailureMessage([file('a.jpg')], 'Permission denied'))
            .toBe("Couldn't move a.jpg to the Trash — permission denied. It's still in the show.");
    });

    it('counts a batch rather than naming one of them', () => {
        expect(trashFailureMessage([file('a.jpg'), file('b.jpg')]))
            .toBe("Couldn't move 2 files to the Trash. They're still in the show.");
    });

    /**
     * The real string macOS returned when the Trash refused a file, copied
     * verbatim out of an e2e run. It repeats the filename the toast already
     * names, so only the clause after "because" is worth showing.
     */
    it('keeps only what the user does not already know', () => {
        expect(cleanTrashReason(
            '“t2.jpg” couldn’t be moved to the trash because you don’t have permission to access it.',
        )).toBe('you don’t have permission to access it');
    });

    it('reads as one sentence once it is in the message', () => {
        expect(trashFailureMessage(
            [file('t2.jpg')],
            '“t2.jpg” couldn’t be moved to the trash because you don’t have permission to access it.',
        )).toBe("Couldn't move t2.jpg to the Trash — you don’t have permission to access it. It's still in the show.");
    });

    /** Other platforms bake the full path in instead of a reason clause. */
    it('strips the path the OS repeated back', () => {
        expect(cleanTrashReason("Failed to move item '/Volumes/Camera/DCIM/a.jpg' to trash"))
            .toBe('failed to move item to trash');
    });

    it('keeps a reason that has no path in it', () => {
        expect(cleanTrashReason('Permission denied.')).toBe('permission denied');
    });

    it('does not let a runaway message take over the toast', () => {
        const long = cleanTrashReason('x'.repeat(400));
        expect(long.length).toBeLessThanOrEqual(90);
        expect(long.endsWith('…')).toBe(true);
    });

    it('says nothing extra when the OS gave no reason', () => {
        expect(trashFailureMessage([file('a.jpg')], '   ')).not.toContain('—');
    });
});

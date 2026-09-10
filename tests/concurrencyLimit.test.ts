import { describe, expect, it } from 'vitest';
import { createConcurrencyLimit } from '../electron/concurrencyLimit';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

describe('createConcurrencyLimit', () => {
    it('runs up to the limit at once and queues the rest', async () => {
        const run = createConcurrencyLimit(2);
        let active = 0;
        let peak = 0;
        const gates = [deferred(), deferred(), deferred()];

        const tasks = gates.map(gate => run(async () => {
            active++;
            peak = Math.max(peak, active);
            await gate.promise;
            active--;
        }));

        await Promise.resolve();
        expect(peak).toBe(2);

        gates.forEach(g => g.resolve());
        await Promise.all(tasks);
        expect(peak).toBe(2);
    });

    it('never exceeds the limit when a new call arrives as a slot frees', async () => {
        const run = createConcurrencyLimit(1);
        let active = 0;
        let peak = 0;
        const first = deferred();
        const second = deferred();

        const body = async (gate: Promise<void>) => {
            active++;
            peak = Math.max(peak, active);
            await gate;
            active--;
        };

        const a = run(() => body(first.promise));
        const b = run(() => body(second.promise));

        first.resolve();          // frees the slot and wakes b
        const c = run(() => body(second.promise)); // arrives in the same tick

        second.resolve();
        await Promise.all([a, b, c]);
        expect(peak).toBe(1);
    });

    it('releases the slot when a task throws', async () => {
        const run = createConcurrencyLimit(1);
        await expect(run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(run(async () => 'recovered')).resolves.toBe('recovered');
    });

    it('returns each task its own result', async () => {
        const run = createConcurrencyLimit(2);
        const results = await Promise.all([1, 2, 3, 4].map(n => run(async () => n * 10)));
        expect(results).toEqual([10, 20, 30, 40]);
    });
});

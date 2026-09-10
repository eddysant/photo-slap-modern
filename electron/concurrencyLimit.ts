/**
 * A minimal concurrency gate.
 *
 * Decoding originals is expensive (a 48MP JPEG is ~0.3s, HEIC more) and a
 * fresh grid scroll can ask for hundreds of thumbnails at once, so the number
 * of simultaneous sharp pipelines is capped and the rest queue.
 */
export function createConcurrencyLimit(limit: number) {
    let active = 0;
    const waiting: (() => void)[] = [];

    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= limit) {
            // The releasing task hands its slot straight over, so `active`
            // already accounts for this call when the promise resolves.
            await new Promise<void>(resolve => waiting.push(resolve));
        } else {
            active++;
        }

        try {
            return await fn();
        } finally {
            // Hand the slot to the next waiter rather than releasing it and
            // letting the waiter re-take it. Both hold the line for the
            // app's real callers, which arrive as macrotasks (the microtask
            // queue drains before any of them run). The hand-off is simply
            // correct without depending on that: releasing first leaves a
            // microtask-sized window where a call could see a free slot while
            // a woken waiter is also resuming.
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    };
}

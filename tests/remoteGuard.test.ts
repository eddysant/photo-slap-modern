import { describe, expect, it } from 'vitest';
import { AuthThrottle, UploadBudget, clientKey, generateToken, safeTokenCompare, TOKEN_BYTES } from '../electron/remoteGuard';

describe('session token', () => {
    it('carries enough entropy that guessing it is impractical', () => {
        expect(TOKEN_BYTES).toBeGreaterThanOrEqual(16);
        expect(generateToken()).toHaveLength(TOKEN_BYTES * 2);
    });

    it('is different every time', () => {
        const tokens = new Set(Array.from({ length: 50 }, generateToken));
        expect(tokens.size).toBe(50);
    });
});

describe('safeTokenCompare', () => {
    const token = 'a'.repeat(48);

    it('accepts the exact token', () => {
        expect(safeTokenCompare(token, token)).toBe(true);
    });

    it('rejects a wrong token of the same length', () => {
        expect(safeTokenCompare('b'.repeat(48), token)).toBe(false);
    });

    it('rejects a prefix without throwing on the length mismatch', () => {
        expect(safeTokenCompare('a'.repeat(47), token)).toBe(false);
        expect(safeTokenCompare('', token)).toBe(false);
    });

    it('rejects a missing token', () => {
        expect(safeTokenCompare(null, token)).toBe(false);
        expect(safeTokenCompare(undefined as unknown as string, token)).toBe(false);
    });
});

describe('AuthThrottle', () => {
    it('lets a client through until it exhausts its failures', () => {
        const throttle = new AuthThrottle({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
        expect(throttle.isBlocked('1.2.3.4', 0)).toBe(false);
        throttle.recordFailure('1.2.3.4', 0);
        throttle.recordFailure('1.2.3.4', 10);
        expect(throttle.isBlocked('1.2.3.4', 20)).toBe(false);
        throttle.recordFailure('1.2.3.4', 20);
        expect(throttle.isBlocked('1.2.3.4', 30)).toBe(true);
    });

    it('releases the client once the block expires', () => {
        const throttle = new AuthThrottle({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
        throttle.recordFailure('1.2.3.4', 0);
        throttle.recordFailure('1.2.3.4', 10);
        expect(throttle.isBlocked('1.2.3.4', 4000)).toBe(true);
        expect(throttle.isBlocked('1.2.3.4', 5011)).toBe(false);
    });

    it('reports how long the client must wait', () => {
        const throttle = new AuthThrottle({ maxFailures: 1, windowMs: 1000, blockMs: 5000 });
        throttle.recordFailure('1.2.3.4', 0);
        expect(throttle.retryAfterMs('1.2.3.4', 1000)).toBe(4000);
        expect(throttle.retryAfterMs('other', 1000)).toBe(0);
    });

    it('forgets failures that fall outside the window', () => {
        const throttle = new AuthThrottle({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
        throttle.recordFailure('1.2.3.4', 0);
        throttle.recordFailure('1.2.3.4', 2000); // new window, counts as the first
        expect(throttle.isBlocked('1.2.3.4', 2001)).toBe(false);
    });

    it('throttles each client separately', () => {
        const throttle = new AuthThrottle({ maxFailures: 1, windowMs: 1000, blockMs: 5000 });
        throttle.recordFailure('1.2.3.4', 0);
        expect(throttle.isBlocked('1.2.3.4', 0)).toBe(true);
        expect(throttle.isBlocked('5.6.7.8', 0)).toBe(false);
    });

    it('clears history after a successful auth', () => {
        const throttle = new AuthThrottle({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
        throttle.recordFailure('1.2.3.4', 0);
        throttle.recordSuccess('1.2.3.4');
        throttle.recordFailure('1.2.3.4', 10);
        expect(throttle.isBlocked('1.2.3.4', 20)).toBe(false);
    });
});

describe('UploadBudget', () => {
    it('accepts uploads while there is room', () => {
        const budget = new UploadBudget({ maxFiles: 3, maxTotalBytes: 100 });
        expect(budget.tryReserve(40).ok).toBe(true);
        expect(budget.tryReserve(40).ok).toBe(true);
        expect(budget.used).toEqual({ files: 2, bytes: 80 });
    });

    it('stops a client that repeats an at-the-limit upload', () => {
        const budget = new UploadBudget({ maxFiles: 10, maxTotalBytes: 100 });
        expect(budget.tryReserve(60).ok).toBe(true);
        const rejected = budget.tryReserve(60);
        expect(rejected.ok).toBe(false);
        expect(rejected.ok === false && rejected.error).toMatch(/size limit/i);
    });

    it('caps the file count independently of size', () => {
        const budget = new UploadBudget({ maxFiles: 2, maxTotalBytes: 1_000_000 });
        budget.tryReserve(1);
        budget.tryReserve(1);
        const rejected = budget.tryReserve(1);
        expect(rejected.ok).toBe(false);
        expect(rejected.ok === false && rejected.error).toMatch(/upload limit/i);
    });

    it('gives the reservation back when the write fails', () => {
        const budget = new UploadBudget({ maxFiles: 1, maxTotalBytes: 100 });
        budget.tryReserve(50);
        budget.release(50);
        expect(budget.used).toEqual({ files: 0, bytes: 0 });
        expect(budget.tryReserve(50).ok).toBe(true);
    });
});

describe('clientKey', () => {
    it('falls back to a constant when the address is unknown', () => {
        expect(clientKey('10.0.0.5')).toBe('10.0.0.5');
        expect(clientKey(undefined)).toBe('unknown');
    });
});

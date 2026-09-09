import crypto from 'node:crypto';

/**
 * Guards for the LAN remote server. The server is reachable by every device
 * on the network, so the token is the only thing between a guest's phone and
 * the user's photo library — these helpers make guessing it impractical and
 * cap what a single session can write.
 */

/** Bytes of entropy in a session token. 192 bits is not worth guessing. */
export const TOKEN_BYTES = 24;

export function generateToken(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time token comparison. A plain `!==` leaks the length of the
 * matching prefix through response timing, which turns a 192-bit search into
 * a per-character one.
 */
export function safeTokenCompare(supplied: string | null, expected: string): boolean {
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual throws on length mismatch, so compare lengths first —
    // the token length is not a secret.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export interface AuthThrottleOptions {
    /** Failures allowed inside the window before the client is blocked. */
    maxFailures?: number;
    /** How long failures are remembered, in ms. */
    windowMs?: number;
    /** How long a blocked client stays blocked, in ms. */
    blockMs?: number;
}

/**
 * Per-client failed-authentication throttle. Without it, a 48-character token
 * is still enumerable by a host that can issue requests as fast as the server
 * answers them.
 */
export class AuthThrottle {
    private readonly maxFailures: number;
    private readonly windowMs: number;
    private readonly blockMs: number;
    private readonly failures = new Map<string, { count: number; first: number; blockedUntil: number }>();

    constructor({ maxFailures = 10, windowMs = 60_000, blockMs = 5 * 60_000 }: AuthThrottleOptions = {}) {
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
        this.blockMs = blockMs;
    }

    /** Milliseconds the client must wait, or 0 when it may proceed. */
    retryAfterMs(client: string, now = Date.now()): number {
        const entry = this.failures.get(client);
        if (!entry) return 0;
        if (entry.blockedUntil > now) return entry.blockedUntil - now;
        return 0;
    }

    isBlocked(client: string, now = Date.now()): boolean {
        return this.retryAfterMs(client, now) > 0;
    }

    recordFailure(client: string, now = Date.now()): void {
        const existing = this.failures.get(client);
        // A first failure, or one after the window lapsed, starts a new window
        // — but it still counts toward the threshold, so maxFailures: 1 blocks
        // immediately rather than never.
        const entry = existing && now - existing.first <= this.windowMs
            ? existing
            : { count: 0, first: now, blockedUntil: existing?.blockedUntil ?? 0 };

        entry.count++;
        if (entry.count >= this.maxFailures) {
            entry.blockedUntil = now + this.blockMs;
            // Restart the window so a blocked client that keeps trying is
            // re-blocked from its next failure rather than released early.
            entry.count = 0;
            entry.first = now;
        }
        this.failures.set(client, entry);
    }

    /** A successful auth clears the client's failure history. */
    recordSuccess(client: string): void {
        this.failures.delete(client);
    }

    reset(): void {
        this.failures.clear();
    }
}

export interface UploadBudgetOptions {
    maxFiles?: number;
    maxTotalBytes?: number;
}

/**
 * Per-session ceiling on guest uploads. The size cap on an individual request
 * does nothing against a client that simply repeats it, so the session tracks
 * a running total and stops accepting once the party has had its share.
 */
export class UploadBudget {
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
    private files = 0;
    private bytes = 0;

    constructor({ maxFiles = 500, maxTotalBytes = 5 * 1024 * 1024 * 1024 }: UploadBudgetOptions = {}) {
        this.maxFiles = maxFiles;
        this.maxTotalBytes = maxTotalBytes;
    }

    /** Reserve room for one upload, or explain why there is none. */
    tryReserve(bytes: number): { ok: true } | { ok: false; error: string } {
        if (this.files + 1 > this.maxFiles) {
            return { ok: false, error: 'Upload limit reached for this session' };
        }
        if (this.bytes + bytes > this.maxTotalBytes) {
            return { ok: false, error: 'Upload size limit reached for this session' };
        }
        this.files++;
        this.bytes += bytes;
        return { ok: true };
    }

    /** Give back a reservation when the write ultimately failed. */
    release(bytes: number): void {
        this.files = Math.max(0, this.files - 1);
        this.bytes = Math.max(0, this.bytes - bytes);
    }

    get used(): { files: number; bytes: number } {
        return { files: this.files, bytes: this.bytes };
    }
}

/** Stable client key for throttling; the port varies per connection. */
export function clientKey(remoteAddress: string | undefined): string {
    return remoteAddress ?? 'unknown';
}

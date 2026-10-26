import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { scanDirectory, type MediaFile } from './fileScanner';
import { isWithin } from './pathAccess';

/**
 * Watches the folders currently on show, so media that appears (or vanishes)
 * while the app is running reaches the slideshow.
 *
 * A photo-frame install runs for weeks on a login item; before this, anything
 * copied or synced into its folder stayed invisible until the next launch.
 *
 * fs.watch events are only ever used as a "something under here changed"
 * hint — the answer comes from re-running `scanDirectory` and diffing against
 * what we last knew. Events are coalesced, duplicated, and sometimes nameless
 * depending on the platform, and `fileScanner` is already the single
 * authority on what counts as playable; interpreting events ourselves would
 * fork that decision.
 */

/** Long enough to coalesce a burst (a Photos export, a sync) into one scan. */
const DEBOUNCE_MS = 1500;
/** Gap between the two size samples that decide a file has finished writing. */
const SETTLE_MS = 700;
/**
 * How many recent admissions to keep re-checking for growth. The window is
 * what keeps this a handful of stats per pass rather than one per file in
 * the library, and a stalled copy resumes long before 64 other files land.
 */
const RECENT_ADMISSIONS = 64;

export interface WatchChange {
    added: MediaFile[];
    removed: string[];
}

export function diffScan(known: Set<string>, scanned: MediaFile[]): WatchChange {
    const present = new Set(scanned.map(file => file.path));
    return {
        added: scanned.filter(file => !known.has(file.path)),
        removed: [...known].filter(p => !present.has(p)),
    };
}

/**
 * Dotfiles never enter a scan, so a change to one can never change the diff.
 * Filtering them at the event is what stops the app watching itself: a tag
 * edit rewrites `.photo-slap.json` every 800ms, and each write would
 * otherwise kick off a full re-scan of the library.
 *
 * A nameless event (the platform didn't say which file) is not ignorable.
 */
export function isIgnoredWatchPath(relative: string | null): boolean {
    if (!relative) return false;
    return relative.split(/[/\\]/).some(segment => segment.startsWith('.'));
}

export interface SettleOptions {
    stat?: (p: string) => Promise<{ size: number }>;
    wait?: (ms: number) => Promise<void>;
    settleMs?: number;
}

async function sizeOf(paths: string[], stat: (p: string) => Promise<{ size: number }>) {
    const sizes = new Map<string, number>();
    await Promise.all(paths.map(async p => {
        try {
            sizes.set(p, (await stat(p)).size);
        } catch {
            // Vanished again, or not readable yet — simply not settled.
        }
    }));
    return sizes;
}

/**
 * Which of `paths` have finished being written, and at what size?
 *
 * A file copied into the folder exists from its first byte, so admitting it
 * on sight would hand the slideshow a truncated image. Two size samples a
 * beat apart is the cheap test: unchanged and non-empty means done. Anything
 * still growing is left out and re-examined on the next pass.
 *
 * The size comes back alongside the path because it is the only record of
 * *how much* of the file was admitted; `RecentAdmissions` keeps it so that a
 * copy which merely paused across both samples can still be caught later.
 */
export async function settleFiles(paths: string[], options: SettleOptions = {}): Promise<Map<string, number>> {
    const settled = new Map<string, number>();
    if (paths.length === 0) return settled;
    const stat = options.stat ?? ((p: string) => fsp.stat(p).then(s => ({ size: s.size })));
    const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

    const before = await sizeOf(paths, stat);
    await wait(options.settleMs ?? SETTLE_MS);
    const after = await sizeOf(paths, stat);

    for (const p of paths) {
        const a = before.get(p);
        const b = after.get(p);
        if (a !== undefined && a === b && a > 0) settled.set(p, a);
    }
    return settled;
}

/**
 * The files admitted in the recent past, each with the size it had when it
 * was admitted. Insertion-ordered and capped, so this stays a short list no
 * matter how long the app runs.
 */
export class RecentAdmissions {
    private sizes = new Map<string, number>();

    constructor(private readonly limit: number = RECENT_ADMISSIONS) {}

    record(filePath: string, size: number): void {
        this.sizes.delete(filePath); // re-insert, so it counts as newest again
        this.sizes.set(filePath, size);
        for (const oldest of this.sizes.keys()) {
            if (this.sizes.size <= this.limit) break;
            this.sizes.delete(oldest);
        }
    }

    forget(filePath: string): void {
        this.sizes.delete(filePath);
    }

    admittedSize(filePath: string): number | undefined {
        return this.sizes.get(filePath);
    }

    paths(): string[] {
        return [...this.sizes.keys()];
    }
}

/**
 * Which recently-admitted files are bigger than they were when we admitted
 * them?
 *
 * `settleFiles` compares two sizes a beat apart, which catches a copy that is
 * actively writing but NOT one that pauses across both samples — over a slow
 * share that happens, both samples read the same size, and the partial file
 * is admitted. From then on it is `known`, so the diff would never notice the
 * copy finishing. A file larger than the one we admitted is that same file
 * arriving a second time, and is treated as new again.
 */
export async function findGrownFiles(
    recent: RecentAdmissions,
    stat: (p: string) => Promise<{ size: number }> = p => fsp.stat(p).then(s => ({ size: s.size })),
): Promise<string[]> {
    const grown: string[] = [];
    await Promise.all(recent.paths().map(async p => {
        const admitted = recent.admittedSize(p);
        if (admitted === undefined) return;
        try {
            if ((await stat(p)).size > admitted) grown.push(p);
        } catch {
            // Gone or unreadable — that is the scan's business, not ours.
        }
    }));
    return grown;
}

export interface ScanForChangesOptions {
    /** Admissions to re-check for growth. Omitted, nothing is re-checked. */
    recent?: RecentAdmissions;
    settle?: (paths: string[]) => Promise<Map<string, number>>;
}

/**
 * One pass: re-scan `root`, diff it against `known`, re-open anything that
 * has grown since it was admitted, and hold back anything still being
 * written. `writing` is how many candidates were held back, so the caller
 * knows to come round again; `sizes` is what each admitted file settled at.
 */
export async function scanForChanges(
    root: string,
    known: Set<string>,
    options: ScanForChangesOptions = {},
): Promise<WatchChange & { writing: number; sizes: Map<string, number> }> {
    const settle = options.settle ?? settleFiles;
    const { files } = await scanDirectory(root);
    const { added, removed } = diffScan(known, files);
    const grown = options.recent ? new Set(await findGrownFiles(options.recent)) : new Set<string>();
    // A grown file is still in `known`, so the diff passed over it — but what
    // is on disk now is not the file we admitted.
    const reopened = files.filter(file => grown.has(file.path) && known.has(file.path));
    const candidates = [...added, ...reopened];
    if (candidates.length === 0) return { added: [], removed, writing: 0, sizes: new Map() };
    const sizes = await settle(candidates.map(file => file.path));
    const ready = candidates.filter(file => sizes.has(file.path));
    return { added: ready, removed, writing: candidates.length - ready.length, sizes };
}

export class DirectoryWatcher {
    private watchers = new Map<string, fs.FSWatcher>();
    /** Per root, the playable files we have already told the renderer about. */
    private known = new Map<string, Set<string>>();
    /** Per root, what the last few admissions measured — see findGrownFiles. */
    private recent = new Map<string, RecentAdmissions>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private scanning = new Set<string>();
    /** Roots that changed again mid-scan, or that still hold a growing file. */
    private dirty = new Set<string>();
    /** `watch()` calls are serialized; two overlapping ones would double-watch. */
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly onChange: (change: WatchChange) => void) {}

    /** Watch exactly these roots, dropping any that are no longer on show. */
    watch(roots: string[]): Promise<void> {
        this.queue = this.queue
            .then(() => this.apply(roots))
            .catch(error => console.error('Directory watch failed:', error));
        return this.queue;
    }

    close(): void {
        for (const root of [...this.watchers.keys()]) this.stopRoot(root);
    }

    /** Test seam — the roots currently being watched. */
    watchedRoots(): string[] {
        return [...this.watchers.keys()];
    }

    /**
     * Record a path as already known, without announcing it.
     *
     * For files the app itself put there: a quick-move whose target folder
     * sits inside the library would otherwise be seen as new media, and the
     * photo the user just filed away would rejoin the show a second later.
     */
    acknowledge(filePath: string): void {
        const resolved = path.resolve(filePath);
        for (const [root, known] of this.known) {
            if (isWithin(root, resolved)) {
                known.add(resolved);
                return;
            }
        }
    }

    private async apply(roots: string[]) {
        const wanted = new Set(roots.map(root => path.resolve(root)));
        for (const root of [...this.watchers.keys()]) {
            if (!wanted.has(root)) this.stopRoot(root);
        }

        for (const root of wanted) {
            if (this.watchers.has(root)) continue;
            // Seed what we already know before watching: a watcher that starts
            // from an empty set would announce the whole library as new.
            let seeded: Set<string>;
            try {
                const { files } = await scanDirectory(root);
                seeded = new Set(files.map(file => file.path));
            } catch (error) {
                console.error(`Could not seed the watcher for ${root}:`, error);
                continue;
            }

            try {
                const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
                    if (isIgnoredWatchPath(filename ? filename.toString() : null)) return;
                    this.schedule(root);
                });
                watcher.on('error', error => {
                    console.error(`Watch error on ${root}:`, error);
                    this.stopRoot(root);
                });
                this.watchers.set(root, watcher);
                this.known.set(root, seeded);
                this.recent.set(root, new RecentAdmissions());
            } catch (error) {
                // Recursive watching is not available on every platform or
                // filesystem. Without it the app behaves exactly as it did
                // before: new media shows up on the next folder open.
                console.error(`Could not watch ${root}:`, error);
            }
        }
    }

    private stopRoot(root: string) {
        const timer = this.timers.get(root);
        if (timer) clearTimeout(timer);
        this.timers.delete(root);
        this.watchers.get(root)?.close();
        this.watchers.delete(root);
        this.known.delete(root);
        this.recent.delete(root);
        this.dirty.delete(root);
    }

    private schedule(root: string, delay = DEBOUNCE_MS) {
        const existing = this.timers.get(root);
        if (existing) clearTimeout(existing);
        this.timers.set(root, setTimeout(() => {
            this.timers.delete(root);
            void this.rescan(root);
        }, delay));
    }

    /** Test seam — run a pass now instead of waiting for an event. */
    async rescan(root: string): Promise<void> {
        if (this.scanning.has(root)) {
            this.dirty.add(root);
            return;
        }
        const known = this.known.get(root);
        const recent = this.recent.get(root);
        if (!known || !recent) return;
        this.scanning.add(root);
        try {
            const { added, removed, writing, sizes } = await scanForChanges(root, known, { recent });
            if (this.known.get(root) !== known) return; // stopped mid-scan

            if (writing > 0) this.dirty.add(root); // come back once they land
            if (added.length === 0 && removed.length === 0) return;

            for (const file of added) {
                known.add(file.path);
                // A size we do not have would read as 0, and then every later
                // pass would see the file as grown. Not watching it is the
                // safer miss.
                const size = sizes.get(file.path);
                if (size !== undefined) recent.record(file.path, size);
            }
            for (const p of removed) {
                known.delete(p);
                recent.forget(p);
            }
            this.onChange({ added, removed });
        } catch (error) {
            console.error(`Watch rescan failed for ${root}:`, error);
        } finally {
            this.scanning.delete(root);
            if (this.dirty.delete(root) && this.known.has(root)) this.schedule(root);
        }
    }
}

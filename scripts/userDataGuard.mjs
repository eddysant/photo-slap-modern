/**
 * Backs up the app's settings and caches before a test run seeds its own,
 * and puts them back afterwards — however the run ends.
 *
 * The scripts used to keep the backup in a variable and restore it from a
 * `finally`. A run that never reached the `finally` — killed, or ended by
 * Node with an unsettled top-level await (exit 13), which skips it — left
 * the test seed in place, and the next run then backed up the *seed* as if
 * it were the user's. Three hung e2e runs in a row erased a real config
 * that way, with no copy anywhere.
 *
 * So the backup lives on disk, beside the files it protects, until the
 * restore has finished. A run that finds one already there knows the last
 * run died, and restores from it before taking a backup of its own.
 */
import fs from 'node:fs';
import path from 'node:path';

const ABSENT = '\u0000absent';

/**
 * @param {string} dir   the app's userData directory
 * @param {string[]} names files in it that the run will overwrite
 * @returns {{ restore: () => void }} restore() is idempotent and synchronous
 */
export function guardUserData(dir, names) {
    const backupDir = path.join(dir, '.test-run-backup');
    fs.mkdirSync(dir, { recursive: true });

    const restoreFrom = () => {
        for (const name of names) {
            const saved = path.join(backupDir, name);
            const live = path.join(dir, name);
            if (!fs.existsSync(saved)) continue;
            const content = fs.readFileSync(saved);
            if (content.toString('utf8') === ABSENT) fs.rmSync(live, { force: true });
            else fs.writeFileSync(live, content);
        }
        fs.rmSync(backupDir, { recursive: true, force: true });
    };

    if (fs.existsSync(backupDir)) {
        console.warn(`A previous test run did not restore the app's settings; restoring them from ${backupDir} first.`);
        restoreFrom();
    }

    // Written to a temp name and renamed, so a run killed mid-backup cannot
    // leave a half-made backup that the next run would trust.
    const staging = `${backupDir}.partial-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    for (const name of names) {
        const live = path.join(dir, name);
        if (fs.existsSync(live)) fs.copyFileSync(live, path.join(staging, name));
        else fs.writeFileSync(path.join(staging, name), ABSENT);
    }
    fs.renameSync(staging, backupDir);

    let done = false;
    const restore = () => {
        if (done) return;
        done = true;
        restoreFrom();
    };

    // The `finally` is still the normal path, because it can wait for the
    // app to quit first (the caches flush on quit, and a restore that lands
    // before that flush is undone by it). These are for every other ending.
    process.on('exit', restore);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => { restore(); process.exit(130); });
    }
    return { restore };
}

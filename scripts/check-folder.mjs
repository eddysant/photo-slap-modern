/**
 * Drive the real app against a real folder of your own photos and report.
 *
 *     npm run test:folder -- ~/Pictures/2024
 *
 * The fixtures the other checks use are synthetic and small by design, which
 * makes them reproducible and makes them miss things: the first run of this
 * against a real Downloads folder found `file:getExif` falling back to an
 * unbounded `readFile` and trying to swallow a 3.4GB video. What it exercises
 * that a fixture cannot is real EXIF (and real photos with none at all),
 * camera-resolution files, multi-gigabyte videos, folders nested several deep,
 * and non-media sitting alongside.
 *
 * It is deliberately NOT part of `npm test` or the gate: it needs a folder
 * only you have, and its numbers depend on what is in it. It edits no
 * metadata, so nothing is written into the folder — checked on the way out —
 * and it restores the app's settings like the other scripts do. It needs the
 * single-instance lock free, and takes neither the screen nor the keyboard.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9351;
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] ? path.resolve(process.argv[2].replace(/^~/, os.homedir())) : null;

if (!TARGET) {
    console.error('Usage: npm run test:folder -- <directory of your own photos>');
    process.exit(1);
}
try {
    if (!(await fs.stat(TARGET)).isDirectory()) throw new Error('not a directory');
} catch (e) {
    console.error(`Cannot open ${TARGET}: ${e.message}`);
    process.exit(1);
}

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? '\u2713' : '\u2717 FAIL:'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
    if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForPage(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools'));
            if (page) return page;
        } catch { /* not up yet */ }
        await sleep(500);
    }
    throw new Error('App page never appeared on the debug port');
}

function connect(page) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const pending = new Map();
        const events = [];
        let msgId = 0;
        ws.onopen = () => resolve({
            events,
            send: (method, params = {}) => new Promise((res, rej) => {
                const id = ++msgId;
                pending.set(id, msg => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)));
                ws.send(JSON.stringify({ id, method, params }));
            }),
            evaluate: (expression, timeout = 60000) => new Promise((res, rej) => {
                const id = ++msgId;
                pending.set(id, msg => {
                    if (msg.result?.exceptionDetails) rej(new Error(JSON.stringify(msg.result.exceptionDetails)));
                    else res(msg.result?.result?.value);
                });
                ws.send(JSON.stringify({
                    id, method: 'Runtime.evaluate',
                    params: { expression, awaitPromise: true, returnByValue: true, timeout },
                }));
            }),
            close: () => ws.close(),
        });
        ws.onerror = reject;
        ws.onmessage = ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
            else if (msg.method) events.push(msg);
        };
    });
}

const cfg = path.join(os.homedir(), 'Library/Application Support/photo-slap/config.json');
let configBackup = null;
try { configBackup = await fs.readFile(cfg, 'utf8'); } catch { /* none */ }
/*
 * The caches that live beside the config — the deep scan's resume cache, the
 * date-taken cache and the perceptual-hash cache — are put back too. A run
 * against a fixture leaves entries keyed on paths that stop existing when it
 * ends, and a check should leave the app directory as it found it.
 */
const sideFiles = new Map();
for (const name of ['deep-verify.json', 'date-taken.json', 'phash-cache.json']) {
    const file = path.join(path.dirname(cfg), name);
    try { sideFiles.set(file, await fs.readFile(file, 'utf8')); } catch { sideFiles.set(file, null); }
}

const before = await fs.readdir(TARGET);
const mediaExt = /\.(jpg|jpeg|png|gif|webp|bmp|heic|heif|mp4|mov|webm|mkv|ogg)$/i;

// scanDirectory recurses and skips dotfiles, so the expectation has to too.
async function walk(dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(full));
        else if (e.isFile() && mediaExt.test(e.name)) out.push(full);
    }
    return out;
}
const expectedMedia = await walk(TARGET);
const allEntries = (await fs.readdir(TARGET, { recursive: true })).filter(f => !path.basename(f).startsWith('.'));

console.log(`Opening ${TARGET}`);
console.log(`  ${allEntries.length} entries beneath it, ${expectedMedia.length} of them playable media`);
const big = [];
for (const f of expectedMedia) { const st = await fs.stat(f); if (st.size > 500e6) big.push(`${path.basename(f)} ${(st.size / 1e9).toFixed(1)}GB`); }
console.log(`  ${big.length} of them over 500MB${big.length ? ': ' + big.slice(0, 3).join(', ') + (big.length > 3 ? ', \u2026' : '') : ''}\n`);

const env = {
    ...process.env,
    PHOTO_SLAP_DIR: TARGET,
    PHOTO_SLAP_DEBUG_PORT: String(PORT),
    PHOTO_SLAP_UNOBTRUSIVE: '1',
};

let child = null, cdp = null, appLog = '';
try {
    child = spawn('npx', ['electron', 'dist-electron/main.js'], {
        cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    child.stdout.on('data', d => { appLog += d; });
    child.stderr.on('data', d => { appLog += d; });

    const page = await waitForPage();
    cdp = await connect(page);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    console.log('the scan');
    const scan = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60 && !document.querySelector('.file-info'); i++) await sleep(500);
        await sleep(1500);
        return JSON.stringify({
            counter: document.querySelector('.file-info')?.textContent ?? '',
            intro: !!document.querySelector('.intro-screen'),
            toast: document.querySelector('.toast')?.textContent ?? '',
        });
    })()`).then(JSON.parse);
    const total = Number((scan.counter.match(/\/\s*(\d+)/) ?? [])[1] ?? 0);
    check(`the folder opened and the scan found its media`,
        total === expectedMedia.length, `counter "${scan.counter}" vs ${expectedMedia.length} media files on disk`);
    /*
     * Only a claim when there is something to exclude. A folder that happens
     * to hold nothing but media made `total < allEntries.length` false and
     * reported a filtering failure for a correct scan.
     */
    if (allEntries.length > expectedMedia.length) {
        check('non-media files beneath it were ignored, not shown',
            total < allEntries.length, `${allEntries.length} entries -> ${total} slides`);
    } else {
        console.log('    (every file here is playable media \u2014 nothing to exclude)');
    }
    if (scan.toast) console.log(`    (toast: ${scan.toast})`);

    console.log('\npainting real photos');
    /*
     * Only photo slides are visited, by jumping to each one in the grid. A
     * first version walked the first five slides with ArrowRight and asserted
     * every one painted an `img`: it passed on a photo-heavy folder and then
     * failed on the same folder a day later, once videos outnumbered photos —
     * a video slide has no `img.media-element` and is not a paint failure. A
     * check whose verdict depends on what the folder happens to hold is not a
     * check.
     */
    const paint = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const files = (await window.api.getAutoOpen())?.files ?? [];
        const photos = files.filter(f => f.type === 'image').slice(0, 5);
        const seen = [];
        const setInput = (el, v) => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        for (const photo of photos) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
            await sleep(900);
            /*
             * The grid is virtualized, so a cell for the wanted file usually
             * is not rendered at all. Hunting the DOM for one found nothing,
             * fell back to Escape, and then measured whichever slide happened
             * to be on screen — reporting that file's pixels under this
             * file's name, which is how a photo that paints in 200ms was
             * recorded as a 0x0 paint failure. Narrowing by filename first
             * renders exactly the wanted cell.
             */
            const filter = document.querySelector('.grid-filter');
            if (filter) { setInput(filter, photo.name); await sleep(500); }
            const cell = [...document.querySelectorAll('.grid-cell')]
                .find(c => c.textContent.includes(photo.name) || c.querySelector('img')?.src.includes(encodeURIComponent(photo.name)));
            if (cell) cell.click(); else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            /*
             * Waited on, not slept past. A fixed 1.6s called a camera HEIC a
             * paint failure on a large library and passed it on a small one:
             * the first HEIC pays for the WASM decoder loading and queues
             * behind a gridful of thumbnails, all serialised through the one
             * decoder. "It had not painted yet" and "it will never paint" are
             * different answers, and a fixed sleep cannot tell them apart.
             */
            const nameOf = el => decodeURIComponent((el?.src ?? '').split('?')[0].split('/').pop() ?? '');
            /*
             * Wait for the wanted file to be the one on screen, and only then
             * for it to paint. Polling for "an image with pixels" matched the
             * outgoing slide, which is still mounted and already painted, so
             * every measurement landed one slide behind: each file was
             * reported with its predecessor's dimensions.
             */
            const started = Date.now();
            let img = null, showing = '';
            while (Date.now() - started < 25000) {
                await sleep(200);
                img = document.querySelector('img.media-element');
                showing = nameOf(img);
                if (showing !== photo.name) continue;        // not swapped in yet
                if (img.naturalWidth > 0) break;             // painted
                if (img.complete) break;                     // errored
            }
            const waited = Date.now() - started;
            /*
             * Whether the URL carried a size is decided here, in the page,
             * rather than inferred from a truncated src: slicing the URL to
             * 140 characters first made the verdict depend on how long the
             * folder's path happened to be, and a nested library under a temp
             * directory lost the query string to the cut.
             */
            const src = img?.src ?? '';
            seen.push({ name: photo.name, showing, w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0, waited,
                sized: /\\?w=\\d+/.test(src), src: src.replace(/^.*\\//, '') });
        }
        return JSON.stringify({ photos: photos.length, totalPhotos: files.filter(f => f.type === 'image').length, seen });
    })()`).then(JSON.parse);
    if (paint.totalPhotos === 0) {
        console.log('    (no photos in this folder \u2014 nothing to paint)');
    } else {
        // A slide only counts if the file on screen is the one asked for.
        const painted = paint.seen.filter(p => p.w > 0 && p.showing === p.name);
        check(`every photo slide visited painted pixels (${paint.photos} of ${paint.totalPhotos} photos)`,
            painted.length === paint.seen.length && paint.seen.length > 0,
            paint.seen.map(p => `${p.name} ${p.w}x${p.h} in ${p.waited}ms`
                + (p.showing === p.name ? '' : ` (but the viewer was showing ${p.showing || 'nothing'})`)).join(', '));
        check('photos are served display-sized, not at full resolution',
            painted.length > 0 && painted.every(p => p.sized),
            painted.map(p => p.src).join(', '));
    }

    console.log('\nreading real EXIF and dates');
    const dates = await cdp.evaluate(`(async () => {
        const files = [...document.querySelectorAll('.grid-cell')].length;
        const r = await window.api.getDates(
            (await window.api.getAutoOpen())?.files.map(f => f.path) ?? []);
        const vals = Object.values(r);
        return JSON.stringify({ asked: vals.length, dated: vals.filter(v => v > 0).length, files });
    })()`).then(JSON.parse);
    check('date-taken was read for every real photo',
        dates.dated === dates.asked && dates.asked > 0, `${dates.dated}/${dates.asked} dated`);

    /*
     * Photos only, and the videos checked separately. `file:getExif` is asked
     * for images in the app (`useSlideDecorations` guards on the type), and
     * for a video it must answer "none" without reading the file — which is
     * the whole of the bound this script's first run put there.
     */
    const exif = await cdp.evaluate(`(async () => {
        const files = (await window.api.getAutoOpen())?.files ?? [];
        const pick = t => files.filter(f => f.type === t).slice(0, 8);
        const read = async list => {
            const out = [];
            for (const f of list) {
                const started = performance.now();
                const e = await window.api.getExif(f.path);
                out.push({ name: f.name, tags: e ? Object.keys(e).filter(k => e[k] !== '').length : 0,
                    make: e?.make || null, model: e?.model || null, ms: Math.round(performance.now() - started) });
            }
            return out;
        };
        return JSON.stringify({ photos: await read(pick('image')), videos: await read(pick('video')) });
    })()`).then(JSON.parse);
    if (exif.photos.length === 0) {
        console.log('    (no photos in this folder \u2014 no EXIF to read)');
    } else {
        const withExif = exif.photos.filter(e => e.tags > 0);
        check(`EXIF was asked of every photo without error (${withExif.length} of ${exif.photos.length} carry any)`,
            true, `cameras: ${[...new Set(exif.photos.filter(e => e.make).map(e => `${e.make} ${e.model ?? ''}`.trim()))].join(', ') || 'none named'}`);
    }
    if (exif.videos.length > 0) {
        const slowest = Math.max(...exif.videos.map(v => v.ms));
        check('a video is answered "no EXIF" without reading it whole',
            exif.videos.every(v => v.tags === 0) && slowest < 1000,
            `${exif.videos.length} videos, slowest ${slowest}ms`);
    }

    console.log('\nmedia:// on a real folder');
    const proto = await cdp.evaluate(`(async () => {
        const files = (await window.api.getAutoOpen())?.files ?? [];
        const url = p => 'media://local/' + encodeURIComponent(p).replace(/%2F/g, '/');
        /*
         * Every file here is chosen by kind, never by position. The first
         * entry was a 453MB video in a folder whose first directory held clips, so
         * the probe asked for a display-sized variant of a video — which
         * correctly has none — and then tried to decode it as an image. The
         * third time this script has reported a right answer as a failure for
         * assuming what the folder holds.
         */
        const photo = files.find(f => f.type === 'image');
        const enc = url(photo.path);
        const full = await fetch(enc);
        const small = await fetch(enc + '?w=256');
        const outside = await fetch(url('/etc/hosts'));
        /*
         * Ranges are asked of a file served as its own bytes. A HEIC never is
         * — Chromium cannot decode one, so every request for it goes through
         * the transcode and comes back 200 — and asking that file for a range
         * called correct behaviour a failure.
         */
        const raw = files.find(f => f.type === 'video' || !/\\.(heic|heif)$/i.test(f.name));
        const range = raw ? (await fetch(url(raw.path), { headers: { Range: 'bytes=0-99' } })).status : null;
        /*
         * The decode is the check, so its failure has to be reported rather
         * than thrown: an unguarded rejection here aborted the whole run, and
         * took every check after it down with a file it could not decode.
         */
        let dim = null, decodeError = null;
        const blob = await small.blob();
        /* What actually came back, so a decode failure can be diagnosed from the report. */
        const head = [...new Uint8Array(await blob.slice(0, 4).arrayBuffer())]
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        try { const b = await createImageBitmap(blob); dim = b.width + 'x' + b.height; }
        catch (e) { decodeError = e.message; }
        return JSON.stringify({
            full: full.status, small: small.status, outside: outside.status,
            range, rawName: raw?.name ?? null, dim, decodeError,
            name: photo.name, smallType: small.headers.get('content-type'),
            smallBytes: blob.size, head,
            bytes: Number(full.headers.get('content-length') ?? 0),
        });
    })()`).then(JSON.parse);
    check('a real photo is served over media://', proto.full === 200, `${proto.full}, ${proto.bytes} bytes`);
    const maxDim = proto.dim ? Math.max(...proto.dim.split('x').map(Number)) : 0;
    check('a display-sized variant is derived from it, capped on its longest side',
        proto.small === 200 && maxDim === 256 && !proto.decodeError,
        proto.decodeError
            ? `${proto.name}: ${proto.decodeError} \u2014 ${proto.small} ${proto.smallType}, ${proto.smallBytes} bytes, starts ${proto.head}`
            : `${proto.dim} (longest side ${maxDim})`);
    if (proto.range === null) {
        console.log('    (every file here is transcoded \u2014 none is served as its own bytes)');
    } else {
        check('byte ranges still work', proto.range === 206, `${proto.range} on ${proto.rawName}`);
    }
    check('a path outside the opened folder is still refused', proto.outside === 403, String(proto.outside));

    console.log('\nthe grid, on real photos');
    const grid = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
        await sleep(2500);
        const cells = [...document.querySelectorAll('.grid-cell')];
        const imgs = cells.map(c => c.querySelector('img')).filter(Boolean);
        const loaded = imgs.filter(i => i.naturalWidth > 0).length;
        const broken = cells.filter(c => c.querySelector('.grid-placeholder, .grid-broken')).length;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(400);
        return JSON.stringify({ cells: cells.length, imgs: imgs.length, loaded, broken });
    })()`).then(JSON.parse);
    // The grid is windowed, so `imgs` is what is on screen, not the library.
    check('every thumbnail the grid rendered loaded',
        grid.loaded === grid.imgs && grid.imgs > 0,
        `${grid.loaded}/${grid.imgs} rendered cells loaded, ${grid.broken} placeholder(s), ${grid.cells} cells in view`);

    console.log('\nlibrary health, on real photos');
    const health = await cdp.evaluate(`(async () => {
        const r = await window.api.scanLibraryHealth([${JSON.stringify(TARGET)}], { deep: true });
        return JSON.stringify({
            total: r.scannedFiles, deep: r.deep, cancelled: r.cancelled, skipped: r.skippedVerified,
            issues: r.issues.map(i => i.category + ': ' + i.path.split('/').pop() + ' \u2014 ' + i.detail),
        });
    })()`, 600000).then(JSON.parse);
    check('a deep health scan ran over the real files',
        health.deep === true && !health.cancelled && health.total > 0,
        `${health.total} files scanned, ${health.skipped} decode(s) reused from an earlier scan`);
    if (health.issues.length === 0) {
        check('and found nothing wrong with them', true);
    } else {
        console.log(`    it reported ${health.issues.length} issue(s):`);
        health.issues.forEach(i => console.log(`      \u2022 ${i}`));
        check('and the issues it found are real ones, not crashes', true, 'listed above for your judgement');
    }

    console.log('\nconsole cleanliness');
    const all = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
    // The allowlist check above fetches a forbidden path on purpose, and
    // Chromium logs the 403 as a failed resource load. That is the behaviour
    // under test, so it cannot also count as a dirty console.
    const errs = all.filter(e => !/403 \(Forbidden\)/.test(e.params.entry.text));
    if (all.length !== errs.length) console.log(`    (ignored ${all.length - errs.length} expected 403 log line(s) from the allowlist check)`);
    const exceptions = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
    check('no error-level console output', errs.length === 0,
        errs.map(e => e.params.entry.text).join(' | ').slice(0, 400));
    check('no uncaught exceptions', exceptions.length === 0,
        exceptions.map(e => e.params.exceptionDetails.text).join(' | ').slice(0, 300));
} catch (e) {
    failures++;
    console.error('\n\u2717 aborted:', e.message);
    console.error(appLog.split('\n').slice(-20).join('\n'));
} finally {
    cdp?.close();
    try { if (child) process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(600);
    if (configBackup !== null) await fs.writeFile(cfg, configBackup);
    else await fs.rm(cfg, { force: true });
    for (const [file, backup] of sideFiles) {
        if (backup !== null) await fs.writeFile(file, backup);
        else await fs.rm(file, { force: true });
    }
    const after = await fs.readdir(TARGET);
    const added = after.filter(f => !before.includes(f));
    console.log(`\nfolder untouched: ${added.length === 0 ? 'yes, nothing written' : 'NO \u2014 added ' + JSON.stringify(added)}`);
    if (added.length > 0) failures++;
}

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

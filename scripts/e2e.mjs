#!/usr/bin/env node
// End-to-end test: launches the real app against a generated fixture folder
// and drives the renderer over the Chrome DevTools Protocol.
//
//   npm run test:e2e
//
// Notes:
// - NOT headless: an app window opens briefly on screen.
// - The app is single-instance; close any running photo-slap first.
// - Your settings are backed up and restored (the test forces the star wipe).
// - Requires Node >= 21 (built-in WebSocket).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PORT = 9333;
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEIC_SAMPLE_URL = 'https://nokiatech.github.io/heif/content/images/autumn_1440x960.heic';

const configPath = () => {
    const home = os.homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/photo-slap/config.json');
    if (process.platform === 'win32') return path.join(process.env.APPDATA ?? home, 'photo-slap/config.json');
    return path.join(home, '.config/photo-slap/config.json');
};

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗ FAIL:'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fixture ----------
async function makeFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-e2e-'));

    const svg = (grad, shape) => `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" ${grad}><stop offset="0" stop-color="#ff004c"/><stop offset="1" stop-color="#001122"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#g)"/>${shape}</svg>`;

    // Structured images: solid colors would all blockhash identically.
    const a = svg('x1="0" y1="0" x2="1" y2="1"', '<circle cx="250" cy="200" r="120" fill="#fff"/><rect x="450" y="350" width="250" height="180" fill="#000"/>');
    const b = svg('x1="1" y1="0" x2="0" y2="1"', '<polygon points="400,80 550,500 250,500" fill="#ff0"/>');

    await sharp(Buffer.from(a)).jpeg({ quality: 92 }).toFile(path.join(dir, 'a.jpg'));
    await fs.copyFile(path.join(dir, 'a.jpg'), path.join(dir, 'a-copy.jpg')); // exact duplicate
    await sharp(path.join(dir, 'a.jpg')).resize(400, 300).jpeg({ quality: 85 }).toFile(path.join(dir, 'a-small.jpg')); // similar
    await sharp(Buffer.from(b)).png().toFile(path.join(dir, 'b.png'));

    // Deterministic mtimes for the date-sort checks (none of these carry EXIF)
    await fs.utimes(path.join(dir, 'a.jpg'), new Date('2000-01-01'), new Date('2000-01-01'));
    await fs.utimes(path.join(dir, 'a-copy.jpg'), new Date('2001-01-01'), new Date('2001-01-01'));
    await fs.utimes(path.join(dir, 'a-small.jpg'), new Date('2002-01-01'), new Date('2002-01-01'));
    await fs.utimes(path.join(dir, 'b.png'), new Date('2099-01-01'), new Date('2099-01-01'));

    // HEIC sample (optional — skipped if offline)
    let heicPath = null;
    try {
        const res = await fetch(HEIC_SAMPLE_URL, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
            heicPath = path.join(dir, 'autumn.heic');
            await fs.writeFile(heicPath, Buffer.from(await res.arrayBuffer()));
        }
    } catch {
        console.log('  (offline — skipping HEIC checks)');
    }

    // Two encodes of the same clip, for video frame-matching (optional — needs ffmpeg)
    let hasVideos = false;
    const clip = path.join(dir, 'clip.mp4');
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', clip]);
    if (gen.status === 0) {
        const re = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', 'scale=160:120', '-b:v', '100k', path.join(dir, 'clip-small.mp4')]);
        hasVideos = re.status === 0;
    }
    if (!hasVideos) console.log('  (no ffmpeg — skipping video-similarity checks)');

    return { dir, heicPath, hasVideos };
}

// ---------- CDP ----------
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
    throw new Error('App page never appeared on the debug port (is another photo-slap instance holding the single-instance lock?)');
}

function connect(page) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const pending = new Map();
        let msgId = 0;
        ws.onopen = () => resolve({
            evaluate: expression => new Promise((res, rej) => {
                const id = ++msgId;
                pending.set(id, msg => {
                    if (msg.result?.exceptionDetails) rej(new Error(JSON.stringify(msg.result.exceptionDetails)));
                    else res(msg.result?.result?.value);
                });
                ws.send(JSON.stringify({
                    id, method: 'Runtime.evaluate',
                    params: { expression, awaitPromise: true, returnByValue: true, timeout: 60000 },
                }));
            }),
            close: () => ws.close(),
        });
        ws.onerror = reject;
        ws.onmessage = ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        };
    });
}

// ---------- main ----------
const { dir: fixture, heicPath, hasVideos } = await makeFixture();
const fixtureCount = (await fs.readdir(fixture)).length;

// Back up user settings, seed the star wipe
const cfg = configPath();
let configBackup = null;
try { configBackup = await fs.readFile(cfg, 'utf8'); } catch { /* no config yet */ }
await fs.mkdir(path.dirname(cfg), { recursive: true });
await fs.writeFile(cfg, JSON.stringify({
    transitionStyle: 'star', isShuffle: false, mediaFilter: 'both', sortOrder: 'name',
    isKenBurns: false, isExifEnabled: false, isSmart: false, slideDuration: 3000,
}));

console.log('Launching app against', fixture);
const child = spawn('npm', ['run', 'dev'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PHOTO_SLAP_DIR: fixture, PHOTO_SLAP_DEBUG_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
});
let appLog = '';
child.stdout.on('data', d => { appLog += d; });
child.stderr.on('data', d => { appLog += d; });

let cdp = null;
try {
    const page = await waitForPage();
    cdp = await connect(page);

    // Wait for the auto-opened folder to load
    for (let i = 0; i < 40; i++) {
        const counter = await cdp.evaluate(`document.querySelector('.file-info')?.textContent ?? ''`);
        if (counter) break;
        await sleep(500);
    }

    console.log('media:// protocol');
    const jpgUrl = `media://local${path.join(fixture, 'a.jpg').split('/').map(encodeURIComponent).join('/')}`;
    const base = await cdp.evaluate(`(async () => {
        const img = document.querySelector('img.media-element');
        let forbidden = 0;
        try { forbidden = (await fetch('media://local/definitely/not/allowed.jpg')).status; } catch { forbidden = -1; }
        const ranged = await fetch(${JSON.stringify(jpgUrl)}, { headers: { Range: 'bytes=0-99' } });
        const scaledBmp = await createImageBitmap(await (await fetch(${JSON.stringify(jpgUrl)} + '?w=512')).blob());
        return JSON.stringify({
            counter: document.querySelector('.file-info')?.textContent ?? '',
            naturalWidth: img?.naturalWidth ?? 0,
            slideUsesDisplayVariant: (img?.src ?? '').includes('?w='),
            forbidden,
            range: { status: ranged.status, length: (await ranged.arrayBuffer()).byteLength, contentRange: ranged.headers.get('content-range') },
            scaled: { w: scaledBmp.width, h: scaledBmp.height },
        });
    })()`).then(JSON.parse);
    check('slideshow auto-opened the fixture', base.counter === `1 / ${fixtureCount}`, base.counter);
    check('image rendered through media://', base.naturalWidth > 0, `naturalWidth=${base.naturalWidth}`);
    check('path outside allowed roots is 403', base.forbidden === 403, `status=${base.forbidden}`);
    check('byte-range requests get 206 partial content',
        base.range.status === 206 && base.range.length === 100 && /^bytes 0-99\//.test(base.range.contentRange ?? ''),
        `${base.range.status} ${base.range.contentRange}`);
    check('?w=512 serves a downscaled variant', base.scaled.w === 512 && base.scaled.h === 384, `${base.scaled.w}x${base.scaled.h}`);
    check('slideshow paints display-sized images', base.slideUsesDisplayVariant === true);

    if (heicPath) {
        console.log('HEIC transcoding');
        const heic = await cdp.evaluate(`(async () => {
            const res = await fetch(${JSON.stringify(`media://local${heicPath.split('/').map(encodeURIComponent).join('/')}`)});
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob);
            return JSON.stringify({ status: res.status, type: res.headers.get('content-type'), w: bmp.width, h: bmp.height });
        })()`).then(JSON.parse);
        check('HEIC served as JPEG', heic.status === 200 && heic.type === 'image/jpeg', `${heic.status} ${heic.type}`);
        check('HEIC decodes to full-size image', heic.w === 1440 && heic.h === 960, `${heic.w}x${heic.h}`);
    }

    console.log('star wipe');
    const wipe = await cdp.evaluate(`(async () => {
        // Warm-up transition: the very first slide mounted under the default
        // transition (settings hydrate async), so it has no star clip yet.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        await new Promise(r => setTimeout(r, 1000));
        const samples = [];
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        for (let i = 0; i < 9; i++) {
            await new Promise(r => setTimeout(r, 60));
            const slides = document.querySelectorAll('.viewer-container > div');
            samples.push({ mounted: slides.length, clips: [...slides].map(el => getComputedStyle(el).clipPath) });
        }
        return JSON.stringify(samples);
    })()`).then(JSON.parse);
    const midWipe = wipe.filter(s => s.mounted === 2);
    const incoming = midWipe.map(s => s.clips[1]).filter(c => c?.startsWith('polygon'));
    check('both slides mounted during the wipe', midWipe.length >= 5, `${midWipe.length}/9 samples`);
    check('incoming clip-path interpolates', new Set(incoming).size >= 4, `${new Set(incoming).size} distinct shapes`);
    check('outgoing slide keeps full-star clip', midWipe.every(s => s.clips[0]?.includes('-150%')));

    console.log('directional slide transition');
    const dir = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        // Switch the transition style to "slide"
        document.querySelector('button[title="Settings"]').click();
        await sleep(400);
        const select = [...document.querySelectorAll('select')]
            .find(s => [...s.options].some(o => o.value === 'star'));
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, 'slide');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(400);

        // Sample the outgoing slide's translateX right after a nav keypress:
        // forward should move left (negative), backward should move right.
        const waitIdle = async () => {
            for (let i = 0; i < 40; i++) {
                const els = document.querySelectorAll('.viewer-container > div');
                if (els.length === 1) {
                    const t = getComputedStyle(els[0]).transform;
                    if (t === 'none' || Math.abs(new DOMMatrix(t).m41) < 1) return;
                }
                await sleep(100);
            }
        };
        const sampleExitX = async (key) => {
            await waitIdle(); // don't dispatch mid-transition
            window.dispatchEvent(new KeyboardEvent('keydown', { key }));
            const xs = [];
            for (let i = 0; i < 6; i++) {
                await sleep(45);
                const el = document.querySelector('.viewer-container > div');
                if (el) xs.push(new DOMMatrix(getComputedStyle(el).transform).m41);
            }
            return xs;
        };
        const forward = await sampleExitX('ArrowRight');
        const backward = await sampleExitX('ArrowLeft');
        return JSON.stringify({ forward, backward });
    })()`).then(JSON.parse);
    check('forward exit slides left', Math.min(...dir.forward) < -50, `min x=${Math.min(...dir.forward).toFixed(0)}`);
    check('backward exit slides right (reversed)', Math.max(...dir.backward) > 50, `max x=${Math.max(...dir.backward).toFixed(0)}`);

    console.log('date sort');
    const sortResult = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const setSort = async (value) => {
            const select = [...document.querySelectorAll('select')]
                .find(s => [...s.options].some(o => o.value === 'date-desc'));
            Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(1500); // date lookup + re-sort
            return document.title;
        };
        document.querySelector('button[title="Settings"]').click();
        await sleep(500);
        const newestFirst = await setSort('date-desc');
        const oldestFirst = await setSort('date-asc');
        const byName = await setSort('name');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(300);
        return JSON.stringify({ newestFirst, oldestFirst, byName });
    })()`).then(JSON.parse);
    check('newest-first puts b.png (2099) first', sortResult.newestFirst === 'b.png', sortResult.newestFirst);
    check('oldest-first puts a.jpg (2000) first', sortResult.oldestFirst === 'a.jpg', sortResult.oldestFirst);
    check('name sort restores a-copy.jpg first', sortResult.byName === 'a-copy.jpg', sortResult.byName);

    console.log('zoom & pan');
    const zoom = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const zp = document.querySelector('.zoom-pan');
        const rect = zp.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        zp.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        await sleep(100);
        const zoomedTransform = document.querySelector('.zoom-pan-content').style.transform;
        zp.dispatchEvent(new MouseEvent('dblclick', { clientX: cx, clientY: cy, bubbles: true }));
        await sleep(100);
        const resetTransform = document.querySelector('.zoom-pan-content').style.transform;
        return JSON.stringify({ zoomedTransform, resetTransform });
    })()`).then(JSON.parse);
    const zoomScale = parseFloat(zoom.zoomedTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? '1');
    check('wheel zooms in', zoomScale > 1.5, zoom.zoomedTransform);
    check('double-click resets zoom', /scale\(1\)/.test(zoom.resetTransform), zoom.resetTransform);

    console.log('pinch zoom');
    const pinchTransform = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const zp = document.querySelector('.zoom-pan');
        const r = zp.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const pe = (type, id, x, y) => zp.dispatchEvent(new PointerEvent(type, {
            pointerId: id, pointerType: 'touch', isPrimary: id === 1,
            clientX: x, clientY: y, bubbles: true,
        }));
        // Two fingers 80px apart spread to 320px apart = 4x pinch
        pe('pointerdown', 1, cx - 40, cy);
        pe('pointerdown', 2, cx + 40, cy);
        pe('pointermove', 1, cx - 160, cy);
        pe('pointermove', 2, cx + 160, cy);
        pe('pointerup', 1, cx - 160, cy);
        pe('pointerup', 2, cx + 160, cy);
        await sleep(100);
        const transform = document.querySelector('.zoom-pan-content').style.transform;
        zp.dispatchEvent(new MouseEvent('dblclick', { clientX: cx, clientY: cy, bubbles: true }));
        return transform;
    })()`);
    const pinchScale = parseFloat(pinchTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? '1');
    check('two-finger pinch zooms ~4x', pinchScale > 2.5 && pinchScale < 6, pinchTransform);

    console.log('slide timer, favorites, tags');
    const extras = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const out = {};
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        await sleep(300);
        out.timerVisible = !!document.querySelector('.slide-timer');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        await sleep(200);
        out.timerGoneWhenPaused = !document.querySelector('.slide-timer');

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));
        await sleep(200);
        out.heart = !!document.querySelector('.fav-indicator');

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
        await sleep(200);
        out.tagEditor = !!document.querySelector('.tag-editor');
        const input = document.querySelector('.tag-add-form input');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'beach');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await sleep(200);
        out.chipOn = !!document.querySelector('.tag-chip.on');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(1200); // wait out the sidecar save debounce
        return JSON.stringify(out);
    })()`).then(JSON.parse);
    check('slide timer bar shows while playing, hides when paused', extras.timerVisible && extras.timerGoneWhenPaused);
    check('H favorites the slide (heart indicator)', extras.heart);
    check('tag editor adds and applies a tag', extras.tagEditor && extras.chipOn);
    try {
        const sidecar = JSON.parse(await fs.readFile(path.join(fixture, '.photo-slap.json'), 'utf8'));
        check('sidecar file saved next to the photos',
            sidecar.favorites.length === 1 && sidecar.tagNames.includes('beach'),
            `favorites=${JSON.stringify(sidecar.favorites)} tagNames=${JSON.stringify(sidecar.tagNames)}`);
    } catch (e) {
        check('sidecar file saved next to the photos', false, e.message);
    }

    console.log('grid view');
    const grid = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const setInput = (el, v) => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
        await sleep(400);
        const count = document.querySelectorAll('.grid-cell').length;

        // Filename filter narrows the grid
        const filter = document.querySelector('.grid-filter');
        setInput(filter, 'b.png');
        await sleep(300);
        const filteredCount = document.querySelectorAll('.grid-cell').length;
        setInput(filter, '');
        await sleep(300);

        document.querySelectorAll('.grid-cell')[1]?.click(); // jump to the second file
        await sleep(700);
        const counter = document.querySelector('.file-info')?.textContent;
        const closed = !document.querySelector('.grid-overlay');
        // return to the first slide so later assertions start from 1 / N
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        await sleep(900);
        return JSON.stringify({ count, filteredCount, counter, closed });
    })()`).then(JSON.parse);
    check('grid shows every file', grid.count === fixtureCount, `${grid.count} cells`);
    check('filename filter narrows the grid', grid.filteredCount === 1, `${grid.filteredCount} cell(s) for "b.png"`);
    check('clicking a cell jumps and closes the grid', grid.closed && grid.counter === `2 / ${fixtureCount}`, grid.counter);

    console.log('grid batch operations + filters');
    const gridBatch = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
        await sleep(400);
        const heartsBefore = document.querySelectorAll('.grid-heart').length;
        // select two cells and batch-favorite them
        document.querySelector('.grid-select-toggle').click();
        await sleep(150);
        const cells = document.querySelectorAll('.grid-cell');
        cells[1].click();
        cells[2].click();
        await sleep(150);
        const selCount = document.querySelector('.grid-batch-count')?.textContent ?? '';
        document.querySelector('.batch-fav').click();
        await sleep(300);
        const heartsAfter = document.querySelectorAll('.grid-heart').length;
        // favorites-only filter
        document.querySelector('.grid-select-toggle').click();
        await sleep(100);
        [...document.querySelectorAll('.grid-chip')].find(b => b.textContent.includes('Favs')).click();
        await sleep(200);
        const favCells = document.querySelectorAll('.grid-cell').length;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
        await sleep(1200); // let the sidecar save debounce flush
        return JSON.stringify({ heartsBefore, selCount, heartsAfter, favCells });
    })()`).then(JSON.parse);
    check('batch select shows a count', gridBatch.selCount === '2 selected', gridBatch.selCount);
    check('batch favorite hearts the selection',
        gridBatch.heartsAfter === gridBatch.heartsBefore + 2, `${gridBatch.heartsBefore} -> ${gridBatch.heartsAfter}`);
    check('grid favorites-only filter narrows to favorites',
        gridBatch.favCells === gridBatch.heartsAfter, `${gridBatch.favCells} cells`);

    console.log('photo frame');
    const frame = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
        await sleep(500);
        const clock = document.querySelector('.frame-clock')?.textContent ?? '';
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
        await sleep(200);
        const gone = !document.querySelector('.frame-overlay');
        return JSON.stringify({ clock, gone });
    })()`).then(JSON.parse);
    check('photo-frame overlay shows a clock', /\d{1,2}:\d{2}/.test(frame.clock), frame.clock);
    check('P toggles the overlay off', frame.gone);

    console.log('phone remote');
    const remote = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        document.querySelector('button[title="Settings"]').click();
        await sleep(400);
        const label = [...document.querySelectorAll('.checkbox-control')].find(l => l.textContent.includes('Phone Remote'));
        label.querySelector('input').click();
        for (let i = 0; i < 25 && !document.querySelector('.remote-url'); i++) await sleep(200);
        const url = document.querySelector('.remote-url')?.textContent ?? '';
        const qr = !!document.querySelector('.remote-qr');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await sleep(300);
        return JSON.stringify({ url, qr });
    })()`).then(JSON.parse);
    check('remote URL displayed with token', /^http:\/\/.+\?t=[0-9a-f]+$/.test(remote.url), remote.url);
    check('remote QR code rendered', remote.qr === true);
    if (remote.url.startsWith('http')) {
        const remoteBase = new URL(remote.url);
        const token = remoteBase.searchParams.get('t');
        const statusUrl = `${remoteBase.origin}/api/status?t=${token}`;
        const status = await (await fetch(statusUrl)).json();
        check('remote status reports the current file', typeof status.name === 'string' && status.total > 0, JSON.stringify(status));
        await fetch(`${remoteBase.origin}/api/action?t=${token}`, { method: 'POST', body: JSON.stringify({ action: 'next' }) });
        await sleep(1300);
        const after = await (await fetch(statusUrl)).json();
        check('remote "next" advances the slideshow', after.index === status.index + 1, `${status.index} -> ${after.index}`);
        const unauth = await fetch(`${remoteBase.origin}/api/status`);
        check('remote rejects requests without the token', unauth.status === 403, String(unauth.status));
        // back to the first slide so the dedupe assertions start from 1 / N
        await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))`);
        await sleep(1200);
    }

    console.log('dedupe (worker + transitive groups + slideshow refresh)');
    const dedupe = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const btnByText = txt => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt));
        const before = document.querySelector('.file-info')?.textContent;
        document.querySelector('button[title="Settings"]').click();
        await sleep(500);
        btnByText('FIND DUPLICATES').click();
        await sleep(300);
        // Set the strictness slider to "Normal" (perceptual matching)
        const slider = document.querySelector('.strictness-slider');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider, '2');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(100);
        btnByText('START SCAN').click();
        for (let i = 0; i < 120 && !document.querySelector('.step-review, .step-done'); i++) await sleep(250);
        const header = document.querySelector('.progress-indicator')?.textContent ?? '';
        await sleep(600); // let the compare cards load their metadata
        const metaName = document.querySelector('.file-meta-name')?.textContent ?? '';
        const metaStats = document.querySelector('.file-meta-stats')?.textContent ?? '';
        for (let guard = 0; guard < 10 && document.querySelector('.step-review'); guard++) {
            document.querySelectorAll('.keep-btn')[0].click();
            await sleep(700);
        }
        const done = !!document.querySelector('.step-done');
        btnByText('CLOSE')?.click();
        await sleep(400);
        return JSON.stringify({ before, header, metaName, metaStats, done, after: document.querySelector('.file-info')?.textContent });
    })()`).then(JSON.parse);
    check('similar scan found the 3-file group', dedupe.header.includes('3 files in group'), dedupe.header);
    if (hasVideos) {
        check('re-encoded video pair grouped by frame match', dedupe.header.includes('/ 2'), dedupe.header);
    }
    check('compare card shows filename', /\.(jpg|png)$/.test(dedupe.metaName), dedupe.metaName);
    check('compare card shows size and dimensions', /B/.test(dedupe.metaStats) && /×/.test(dedupe.metaStats), dedupe.metaStats);
    check('review flow completed', dedupe.done);
    const expectedDeletes = hasVideos ? 3 : 2; // 2 from the image trio + 1 from the video pair
    check(`slideshow dropped the ${expectedDeletes} deleted files`,
        dedupe.after === `1 / ${fixtureCount - expectedDeletes}`, `${dedupe.before} -> ${dedupe.after}`);
} catch (e) {
    failures++;
    console.error('✗ E2E aborted:', e.message);
    console.error(appLog.split('\n').slice(-15).join('\n'));
} finally {
    cdp?.close();
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    if (configBackup !== null) await fs.writeFile(cfg, configBackup);
    else await fs.rm(cfg, { force: true });
    await fs.rm(fixture, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nE2E: all checks passed' : `\nE2E: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

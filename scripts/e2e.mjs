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

import { spawn } from 'node:child_process';
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

    return { dir, heicPath };
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
const { dir: fixture, heicPath } = await makeFixture();
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
    const base = await cdp.evaluate(`(async () => {
        const img = document.querySelector('img.media-element');
        let forbidden = 0;
        try { forbidden = (await fetch('media://local/definitely/not/allowed.jpg')).status; } catch { forbidden = -1; }
        return JSON.stringify({
            counter: document.querySelector('.file-info')?.textContent ?? '',
            naturalWidth: img?.naturalWidth ?? 0,
            forbidden,
        });
    })()`).then(JSON.parse);
    check('slideshow auto-opened the fixture', base.counter === `1 / ${fixtureCount}`, base.counter);
    check('image rendered through media://', base.naturalWidth > 0, `naturalWidth=${base.naturalWidth}`);
    check('path outside allowed roots is 403', base.forbidden === 403, `status=${base.forbidden}`);

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

    console.log('dedupe (worker + transitive groups + slideshow refresh)');
    const dedupe = await cdp.evaluate(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const btnByText = txt => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt));
        const before = document.querySelector('.file-info')?.textContent;
        document.querySelector('button[title="Settings"]').click();
        await sleep(500);
        btnByText('FIND DUPLICATES').click();
        await sleep(300);
        btnByText('Similar Photos').click();
        await sleep(100);
        btnByText('START SCAN').click();
        for (let i = 0; i < 120 && !document.querySelector('.step-review, .step-done'); i++) await sleep(250);
        const header = document.querySelector('.progress-indicator')?.textContent ?? '';
        for (let guard = 0; guard < 10 && document.querySelector('.step-review'); guard++) {
            document.querySelectorAll('.keep-btn')[0].click();
            await sleep(700);
        }
        const done = !!document.querySelector('.step-done');
        btnByText('CLOSE')?.click();
        await sleep(400);
        return JSON.stringify({ before, header, done, after: document.querySelector('.file-info')?.textContent });
    })()`).then(JSON.parse);
    check('similar scan found the 3-file group', dedupe.header.includes('3 files in group'), dedupe.header);
    check('review flow completed', dedupe.done);
    check('slideshow dropped the 2 deleted files',
        dedupe.after === `1 / ${fixtureCount - 2}`, `${dedupe.before} -> ${dedupe.after}`);
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

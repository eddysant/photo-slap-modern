#!/usr/bin/env node
// Memory probe: launches the PACKAGED app against a fixture of
// camera-resolution photos, walks the slideshow, and reports the resident
// footprint of the whole process tree plus the renderer's own accounting.
//
//   npm run test:memory -- --app release/<version>/mac-arm64/photo-slap.app
//
// Dev mode is not measured: Vite, the devtools and an unminified bundle add
// a floor that has nothing to do with what ships.
//
// Notes:
// - NOT headless: an app window opens.
// - The app is single-instance; close any running photo-slap first.
// - Your settings are backed up and restored.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PORT = 9334;
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIDES = 40;
/** Camera-resolution photos: the preloader's cost is per decoded pixel. */
const PHOTO_COUNT = Number(process.env.MEM_PHOTOS ?? 30);
const PHOTO_W = Number(process.env.MEM_W ?? 4032);
const PHOTO_H = Number(process.env.MEM_H ?? 3024);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mb = bytes => Math.round(bytes / 1024 / 1024);

const configPath = () => {
    const home = os.homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/photo-slap/config.json');
    if (process.platform === 'win32') return path.join(process.env.APPDATA ?? home, 'photo-slap/config.json');
    return path.join(home, '.config/photo-slap/config.json');
};

const args = process.argv.slice(2);
const appArg = args[args.indexOf('--app') + 1];
if (!appArg || appArg.startsWith('--')) {
    console.error('usage: node scripts/memory.mjs --app <path to photo-slap.app>');
    process.exit(2);
}
const appPath = path.resolve(PROJECT_ROOT, appArg);
const binary = path.join(appPath, 'Contents/MacOS/photo-slap');

// ---------- fixture ----------
async function makeFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-mem-'));
    process.stdout.write(`  generating ${PHOTO_COUNT} ${PHOTO_W}x${PHOTO_H} photos`);
    for (let i = 0; i < PHOTO_COUNT; i++) {
        // Noise, not a gradient: a flat image compresses to nothing and
        // decodes to a texture the GPU can trivially dedupe.
        const noise = Buffer.alloc(PHOTO_W * PHOTO_H * 3);
        for (let p = 0; p < noise.length; p += 3) {
            noise[p] = (p * 7 + i * 29) & 0xff;
            noise[p + 1] = (p * 13 + i * 71) & 0xff;
            noise[p + 2] = (p * 3 + i * 151) & 0xff;
        }
        await sharp(noise, { raw: { width: PHOTO_W, height: PHOTO_H, channels: 3 } })
            .jpeg({ quality: 88 })
            .toFile(path.join(dir, `p${String(i).padStart(2, '0')}.jpg`));
        process.stdout.write('.');
    }
    process.stdout.write('\n');
    return dir;
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
    throw new Error('App page never appeared on the debug port');
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
            send: (method, params = {}) => new Promise(res => {
                const id = ++msgId;
                pending.set(id, msg => res(msg.result));
                ws.send(JSON.stringify({ id, method, params }));
            }),
            close: () => ws.close(),
        });
        ws.onerror = reject;
        ws.onmessage = ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        };
    });
}

/** Resident size of every process in the app's tree, by role. */
function footprint(rootPid) {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args=']).toString();
    const procs = out.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, args: m[4] };
    }).filter(Boolean);

    const tree = new Set([rootPid]);
    for (let changed = true; changed;) {
        changed = false;
        for (const p of procs) {
            if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); changed = true; }
        }
    }

    const byRole = {};
    let total = 0;
    for (const p of procs) {
        if (!tree.has(p.pid)) continue;
        const role = /--type=(\w+)/.exec(p.args)?.[1] ?? 'main';
        byRole[role] = (byRole[role] ?? 0) + p.rss;
        total += p.rss;
    }
    return { total, byRole };
}

// ---------- main ----------
const fixture = await makeFixture();

const cfg = configPath();
let configBackup = null;
try { configBackup = await fs.readFile(cfg, 'utf8'); } catch { /* none */ }
await fs.mkdir(path.dirname(cfg), { recursive: true });
await fs.writeFile(cfg, JSON.stringify({
    transitionStyle: 'fade', isShuffle: false, mediaFilter: 'both', sortOrder: 'name',
    isKenBurns: false, isExifEnabled: false, isSmart: false, slideDuration: 3000,
    autoPlayOnOpen: false,
}));
// A warm derived-image cache is the steady state a photo frame runs in; a
// cold one would measure sharp's decode peak instead.
await fs.rm(path.join(path.dirname(cfg), 'image-cache'), { recursive: true, force: true }).catch(() => { });

const child = spawn(binary, [fixture], {
    env: { ...process.env, PHOTO_SLAP_DEBUG_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
});
let appLog = '';
child.stdout.on('data', d => { appLog += d; });
child.stderr.on('data', d => { appLog += d; });

let cdp = null;
const samples = [];
try {
    cdp = await connect(await waitForPage());
    for (let i = 0; i < 60; i++) {
        const counter = await cdp.evaluate(`document.querySelector('.file-info')?.textContent ?? ''`);
        if (/\d+\s*\/\s*\d+/.test(counter)) break;
        await sleep(500);
    }
    await sleep(3000);

    const sample = async label => {
        const heap = await cdp.evaluate(`JSON.stringify({
            heap: performance.memory?.usedJSHeapSize ?? 0,
            nodes: document.querySelectorAll('*').length,
        })`);
        const { total, byRole } = footprint(child.pid);
        const row = { label, ...JSON.parse(heap), total, byRole };
        samples.push(row);
        console.log(`  ${label.padEnd(22)} rss ${String(mb(total)).padStart(5)} MB   `
            + Object.entries(byRole).map(([k, v]) => `${k} ${mb(v)}`).join('  ')
            + `   jsHeap ${mb(row.heap)} MB`);
        return row;
    };

    const view = JSON.parse(await cdp.evaluate(`JSON.stringify({
        w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
        src: document.querySelector('.media-element')?.currentSrc ?? '',
    })`));
    const requested = /[?&]w=(\d+)/.exec(view.src)?.[1] ?? 'original';
    console.log(`\nphoto-slap memory — ${PHOTO_COUNT} x ${PHOTO_W}x${PHOTO_H} photos`);
    console.log(`  window ${view.w}x${view.h} @${view.dpr}x — slide variant: ${requested}\n`);
    await sample('at rest');

    for (let i = 0; i < SLIDES; i++) {
        await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
        await sleep(400);
        if ((i + 1) % 10 === 0) await sample(`after ${i + 1} slides`);
    }

    // The grid mounts ~50 thumbnails at once — its own spike, and the one
    // place a photo frame is unlikely to sit but a culling session lives in.
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))`);
    await sleep(2500);
    const tiles = await cdp.evaluate(`document.querySelectorAll('.grid-overlay img').length`);
    if (!tiles) throw new Error('grid did not open — the memory numbers below would be meaningless');
    for (let i = 0; i < 6; i++) {
        await cdp.evaluate(`document.querySelector('.grid-overlay').scrollBy(0, 900)`);
        await sleep(400);
    }
    await sample(`grid open (${tiles} tiles)`);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(1500);
    const left = await cdp.evaluate(`document.querySelectorAll('.grid-overlay img').length`);
    await sample(left ? `grid STILL OPEN (${left})` : 'grid closed');

    // What survives a collection is what the app is actually holding.
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(2000);
    await sample('after GC');
} catch (err) {
    console.error('\nFAILED:', err.message);
    if (appLog) console.error(appLog.slice(-2000));
    process.exitCode = 1;
} finally {
    cdp?.close();
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(1500);
    if (configBackup !== null) await fs.writeFile(cfg, configBackup);
    else await fs.rm(cfg, { force: true });
    await fs.rm(fixture, { recursive: true, force: true });
}

const peak = samples.reduce((a, b) => (b.total > a.total ? b : a), samples[0] ?? { total: 0 });
const final = samples[samples.length - 1];
if (final) {
    console.log(`\n  peak  ${mb(peak.total)} MB (${peak.label})`);
    console.log(`  final ${mb(final.total)} MB after GC\n`);
}

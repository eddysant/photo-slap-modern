#!/usr/bin/env node
/**
 * Smoke test for the SHIPPED configuration.
 *
 *   npm run test:smoke                 # built renderer over file:// + strict CSP
 *   npm run test:smoke -- --app <path> # a real .app bundle (asar included)
 *
 * `npm run test:e2e` only ever drives `npm run dev`: the Vite dev server over
 * http://localhost with a relaxed CSP. The shipped app is different in ways
 * that have bitten before — assets resolve relative to a file:// document,
 * `'self'` in the CSP means something else, and anything missing from the
 * electron-builder `files` globs simply is not there. Nothing caught that
 * class of bug automatically; this does.
 *
 * Pass --app to test a real bundle, which additionally covers asar packaging.
 * Without it the test runs dist-electron/main.js directly, which reproduces
 * the production renderer configuration but not the packaging layer.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PORT = 9346;
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗ FAIL:'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const appArgIndex = process.argv.indexOf('--app');
const appBundle = appArgIndex !== -1 ? process.argv[appArgIndex + 1] : null;

// ---------- preconditions ----------
async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

if (!appBundle) {
    const missing = [];
    for (const p of ['dist/index.html', 'dist-electron/main.js']) {
        if (!await exists(path.join(PROJECT_ROOT, p))) missing.push(p);
    }
    if (missing.length > 0) {
        console.error(`Build first (npx tsc && npx vite build) — missing: ${missing.join(', ')}`);
        process.exit(1);
    }
}

// ---------- fixture ----------
async function makeFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-slap-smoke-'));
    const svg = `<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
        <rect width="600" height="400" fill="#ff004c"/><circle cx="300" cy="200" r="120" fill="#fff"/></svg>`;
    await sharp(Buffer.from(svg)).jpeg().toFile(path.join(dir, 'smoke.jpg'));
    return dir;
}

// ---------- CDP with events ----------
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
    throw new Error('App page never appeared on the debug port — see the app output below. '
        + 'Common causes: another photo-slap holds the single-instance lock, no display available, '
        + "or Electron's chrome-sandbox lacks its setuid bit on Linux.");
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
            evaluate: expression => new Promise((res, rej) => {
                const id = ++msgId;
                pending.set(id, msg => {
                    if (msg.result?.exceptionDetails) rej(new Error(JSON.stringify(msg.result.exceptionDetails)));
                    else res(msg.result?.result?.value);
                });
                ws.send(JSON.stringify({
                    id, method: 'Runtime.evaluate',
                    params: { expression, awaitPromise: true, returnByValue: true, timeout: 30000 },
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
            } else if (msg.method) {
                events.push(msg);
            }
        };
    });
}

// ---------- run ----------
const fixture = await makeFixture();
let child = null;
let cdp = null;

// VITE_DEV_SERVER_URL must not leak in: its presence is what selects the dev
// server and the relaxed CSP, which would make this test meaningless.
const env = { ...process.env, PHOTO_SLAP_DIR: fixture, PHOTO_SLAP_DEBUG_PORT: String(PORT) };
delete env.VITE_DEV_SERVER_URL;

const target = appBundle
    ? path.join(appBundle, 'Contents/MacOS/photo-slap')
    : 'npx';
const args = appBundle ? [] : ['electron', 'dist-electron/main.js'];

console.log(`Smoke-testing ${appBundle ?? 'dist-electron/main.js'} (file:// + production CSP)`);

let appLog = '';
try {
    child = spawn(target, args, { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', d => { appLog += d; });
    child.stderr.on('data', d => { appLog += d; });

    const page = await waitForPage();
    cdp = await connect(page);

    // Collect violations and errors from a clean load
    await cdp.send('Log.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(4000);
    for (let i = 0; i < 30; i++) {
        const ready = await cdp.evaluate(`!!document.querySelector('#root')?.children.length`);
        if (ready) break;
        await sleep(500);
    }

    console.log('shipped configuration');
    const info = await cdp.evaluate(`JSON.stringify({
        url: location.href,
        protocol: location.protocol,
        rendered: (document.querySelector('#root')?.children.length ?? 0) > 0,
        styleSheets: document.styleSheets.length,
        cssRules: [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0),
    })`).then(JSON.parse);

    check('renderer loads over file://, not a dev server', info.protocol === 'file:', info.url.slice(0, 72));
    check('React mounted and rendered', info.rendered);
    check('stylesheets applied', info.styleSheets > 0 && info.cssRules > 50, `${info.styleSheets} sheets / ${info.cssRules} rules`);

    console.log('bundled assets');
    // Both fonts matter: Silkscreen is the retro UI face, Inter is the body
    // font on <body>. Either failing makes the app silently render in a
    // fallback — which is exactly how the blocked Inter @import went unnoticed
    // from 1.6.0 until this test existed.
    const fonts = await cdp.evaluate(`(async () => {
        await document.fonts.ready;
        const families = ['Silkscreen', 'Inter'];
        const weights = [400, 700];
        for (const f of families) {
            for (const w of weights) await document.fonts.load(w + ' 16px ' + f).catch(() => {});
        }
        const available = {};
        for (const f of families) {
            for (const w of weights) available[f + ' ' + w] = document.fonts.check(w + ' 16px ' + f);
        }
        const fetches = {};
        for (const f of [
            'fonts/silkscreen-400-latin.woff2', 'fonts/silkscreen-700-latin.woff2',
            'fonts/inter-latin.woff2',
        ]) {
            try { const r = await fetch(f); fetches[f] = r.ok ? (await r.blob()).size : 'HTTP ' + r.status; }
            catch (e) { fetches[f] = 'BLOCKED: ' + e.message; }
        }
        return JSON.stringify({ available, fetches });
    })()`).then(JSON.parse);

    for (const [face, ok] of Object.entries(fonts.available)) {
        check(`${face} is available`, ok);
    }
    check('font files are shipped and readable',
        Object.values(fonts.fetches).every(v => typeof v === 'number' && v > 0), JSON.stringify(fonts.fetches));

    // Snapshot before the deliberate 403 probe below, so the test's own
    // expected failure doesn't show up as error-level console noise.
    const eventsAtLoad = cdp.events.length;

    console.log('media:// under the production CSP');
    const jpg = path.join(fixture, 'smoke.jpg');
    const jpgUrl = `media://local${jpg.split('/').map(encodeURIComponent).join('/')}`;
    const media = await cdp.evaluate(`(async () => {
        let served = 0, forbidden = 0, scaled = null;
        try { served = (await fetch(${JSON.stringify(jpgUrl)})).status; } catch (e) { served = 'ERR ' + e.message; }
        try { forbidden = (await fetch('media://local/definitely/not/allowed.jpg')).status; } catch { forbidden = -1; }
        try {
            const bmp = await createImageBitmap(await (await fetch(${JSON.stringify(jpgUrl)} + '?w=256')).blob());
            scaled = bmp.width + 'x' + bmp.height;
        } catch (e) { scaled = 'ERR ' + e.message; }
        const img = document.querySelector('img.media-element');
        return JSON.stringify({ served, forbidden, scaled, painted: img?.naturalWidth ?? 0 });
    })()`).then(JSON.parse);

    check('media:// serves an allowed file', media.served === 200, String(media.served));
    check('media:// still 403s outside the allowlist', media.forbidden === 403, String(media.forbidden));
    check('derived variants work', media.scaled === '256x171', String(media.scaled));
    check('the slide actually painted', media.painted > 0, `naturalWidth=${media.painted}`);

    console.log('console cleanliness');
    const loadEvents = cdp.events.slice(0, eventsAtLoad);
    const violations = loadEvents.filter(e =>
        e.method === 'Log.entryAdded' &&
        (e.params?.entry?.source === 'security' || /content security policy/i.test(e.params?.entry?.text ?? '')));
    const exceptions = loadEvents.filter(e => e.method === 'Runtime.exceptionThrown');
    const errorLogs = loadEvents.filter(e =>
        e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error' &&
        e.params.entry.source !== 'security');

    // A CSP violation here means something the app needs is not being loaded
    // — this is exactly how the blocked Inter @import was found.
    check('no Content-Security-Policy violations', violations.length === 0,
        violations.map(v => v.params.entry.text).join(' | ').slice(0, 300));
    check('no uncaught exceptions', exceptions.length === 0,
        exceptions.map(e => e.params?.exceptionDetails?.text).join(' | ').slice(0, 300));
    check('no error-level console output', errorLogs.length === 0,
        errorLogs.map(e => e.params.entry.text).join(' | ').slice(0, 300));
} catch (e) {
    failures++;
    console.error('✗ Smoke test aborted:', e.message);
    console.error(appLog.split('\n').slice(-15).join('\n'));
} finally {
    cdp?.close();
    try { if (child) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await fs.rm(fixture, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nSmoke: all checks passed' : `\nSmoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

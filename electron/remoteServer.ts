import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { AuthThrottle, UploadBudget, clientKey, generateToken, safeTokenCompare } from './remoteGuard';

/**
 * LAN remote control + party features: a token-guarded HTTP server serving
 * a mobile page with transport controls, a live thumbnail of the current
 * slide (swipe to navigate), emoji reactions that float over the show, and
 * guest photo uploads that join the running slideshow.
 *
 * Security shape: every request needs the per-session 192-bit token, compared
 * in constant time and rate-limited per client so it cannot be enumerated; the
 * client can never supply a filesystem path (the thumbnail endpoint takes no
 * arguments and serves whatever slide is current); uploads are
 * extension-whitelisted, size-capped per file AND per session,
 * filename-sanitized, and written only under <root>/guests.
 */

export interface RemoteStatus {
    name: string | null;
    index: number | null;
    total: number;
    playing: boolean;
    favorite: boolean;
    /** How many guest-queued slides are waiting. */
    queued: number;
    /** Absolute path of the current file (server-side use only, never sent to clients). */
    path: string | null;
    /** First session root — uploads land in <root>/guests. */
    root: string | null;
}

export interface LibraryPage {
    total: number;
    /** Names and indices only — a client is never told a filesystem path. */
    items: { i: number; name: string; type: 'image' | 'video' }[];
}

export interface RemoteCallbacks {
    getStatus: () => RemoteStatus;
    dispatchAction: (action: string) => void;
    sendReaction: (emoji: string) => void;
    /** Thumbnail of the current slide, or null when it has none (video/none). */
    getThumb: () => Promise<{ buffer: Buffer; type: string } | null>;
    /** Thumbnail of a slide by index, for the browse grid. */
    getThumbAt: (index: number) => Promise<{ buffer: Buffer; type: string } | null>;
    /** A page of the playable list, for guests picking what plays next. */
    getLibrary: (offset: number, limit: number) => LibraryPage;
    /** Queue a slide by index. Returns false when the index is out of range. */
    queueSlide: (index: number) => boolean;
    saveUpload: (name: string, data: Buffer) => Promise<{ ok: boolean; error?: string }>;
}

const ALLOWED_ACTIONS = new Set(['next', 'prev', 'toggle-play', 'favorite']);
const ALLOWED_REACTIONS = new Set(['🎉', '❤️', '😂', '👏', '🔥']);
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
// A per-file cap does nothing against a client that repeats the request, so
// the session also has a ceiling on how much a party can add in total.
const MAX_SESSION_UPLOAD_FILES = 500;
const MAX_SESSION_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
/** Cap a browse page so one request can't ask for a whole 50k-file library. */
const MAX_LIBRARY_PAGE = 60;

/** Parse a client-supplied integer, rejecting anything that isn't one. */
function parseIndex(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>photo-slap remote</title>
<style>
  * { box-sizing: border-box; }
  body { background: #111; color: #fff; font-family: ui-monospace, monospace; margin: 0;
         display: flex; flex-direction: column; align-items: center; gap: 16px;
         padding: 20px 16px 40px; text-align: center; }
  h2 { letter-spacing: 2px; text-shadow: 2px 2px 0 #ff004c; margin: 4px 0 0; }
  #stage { width: 100%; max-width: 420px; aspect-ratio: 4/3; background: #000;
           border: 3px solid #333; display: flex; align-items: center; justify-content: center;
           overflow: hidden; touch-action: pan-y; user-select: none; }
  #thumb { max-width: 100%; max-height: 100%; pointer-events: none; }
  #stage .placeholder { font-size: 44px; color: #444; }
  #name { color: #00aaff; word-break: break-all; min-height: 1.2em; font-size: 13px; }
  #count { color: #888; font-size: 12px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  button { font-size: 26px; padding: 16px 22px; background: #1a1a1a; color: #fff;
           border: 3px solid #444; border-radius: 0; }
  button:active { background: #00aaff; border-color: #fff; }
  #fav.on { color: #ff004c; border-color: #ff004c; }
  .react { font-size: 22px; padding: 10px 14px; }
  #upload-label { display: inline-block; font-size: 15px; padding: 14px 22px; background: #1a1a1a;
                  border: 3px solid #00aaff; color: #00aaff; cursor: pointer; }
  #upload-status { color: #00ff88; font-size: 12px; min-height: 1.2em; }
  input[type=file] { display: none; }
  #queued { color: #ffb300; font-size: 12px; min-height: 1.2em; }
  #browse-btn { font-size: 15px; padding: 14px 22px; border-color: #ffb300; color: #ffb300; }
  #browse { position: fixed; inset: 0; background: #000; overflow-y: auto; padding: 12px; display: none; }
  #browse.open { display: block; }
  #browse-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px;
                position: sticky; top: 0; background: #000; padding: 6px 0 12px; }
  #browse-bar button { font-size: 15px; padding: 10px 16px; }
  #browse-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
  .tile { position: relative; aspect-ratio: 1; background: #161616; border: 2px solid #333;
          overflow: hidden; padding: 0; }
  .tile img { width: 100%; height: 100%; object-fit: cover; }
  .tile.queued { border-color: #ffb300; }
  .tile .badge { position: absolute; inset: auto 0 0 0; background: rgba(0,0,0,.75);
                 font-size: 9px; padding: 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style></head>
<body>
  <h2>PHOTO-SLAP</h2>
  <div id="stage">
    <img id="thumb" alt="" hidden>
    <div class="placeholder" id="placeholder">▧</div>
  </div>
  <div id="name">…</div>
  <div id="count"></div>
  <div class="row">
    <button data-action="prev">⏮</button>
    <button data-action="toggle-play" id="play">▶</button>
    <button data-action="next">⏭</button>
    <button data-action="favorite" id="fav">♥</button>
  </div>
  <div class="row" id="reactions">
    <button class="react">🎉</button><button class="react">❤️</button>
    <button class="react">😂</button><button class="react">👏</button>
    <button class="react">🔥</button>
  </div>
  <button id="browse-btn">▤ Pick what plays next</button>
  <div id="queued"></div>
  <label id="upload-label">＋ Add your photos to the show
    <input id="upload" type="file" accept="image/*,video/*" multiple>
  </label>
  <div id="upload-status"></div>
  <div id="browse">
    <div id="browse-bar">
      <strong>PICK A PHOTO</strong>
      <button id="browse-more">Load more</button>
      <button id="browse-close">✕ Close</button>
    </div>
    <div id="browse-grid"></div>
  </div>
  <script>
    const TOKEN = '__TOKEN__';
    const $ = (id) => document.getElementById(id);
    const send = (action) => fetch('/api/action?t=' + TOKEN, {
      method: 'POST', body: JSON.stringify({ action }),
    }).then(() => setTimeout(poll, 350));
    document.querySelectorAll('button[data-action]').forEach(b => b.onclick = () => send(b.dataset.action));
    document.querySelectorAll('.react').forEach(b => b.onclick = () =>
      fetch('/api/react?t=' + TOKEN, { method: 'POST', body: JSON.stringify({ emoji: b.textContent }) }));

    // Swipe on the thumbnail to navigate
    let touchX = null;
    $('stage').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
    $('stage').addEventListener('touchend', e => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (dx < -40) send('next');
      else if (dx > 40) send('prev');
    }, { passive: true });

    let lastName = null;
    async function poll() {
      try {
        const s = await (await fetch('/api/status?t=' + TOKEN)).json();
        $('name').textContent = s.name ?? '—';
        $('count').textContent = s.index != null ? s.index + ' / ' + s.total : '';
        $('play').textContent = s.playing ? '⏸' : '▶';
        $('fav').classList.toggle('on', !!s.favorite);
        $('queued').textContent = s.queued > 0
          ? s.queued + ' photo' + (s.queued > 1 ? 's' : '') + ' queued by guests'
          : '';
        if (s.name !== lastName) {
          lastName = s.name;
          const img = $('thumb');
          img.hidden = true; $('placeholder').hidden = false;
          if (s.name) {
            img.onload = () => { img.hidden = false; $('placeholder').hidden = true; };
            img.onerror = () => { img.hidden = true; $('placeholder').hidden = false; };
            img.src = '/api/thumb?t=' + TOKEN + '&v=' + encodeURIComponent(s.name);
          }
        }
      } catch { /* app closed */ }
    }
    setInterval(poll, 2000);
    poll();

    // Browse the library and queue a slide to play next
    let browseOffset = 0;
    let browseTotal = 0;
    const grid = $('browse-grid');

    async function loadBrowsePage() {
      const res = await fetch('/api/library?t=' + TOKEN + '&offset=' + browseOffset + '&limit=30');
      const page = await res.json();
      browseTotal = page.total;
      for (const item of page.items) {
        const tile = document.createElement('button');
        tile.className = 'tile';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = '/api/thumb?t=' + TOKEN + '&i=' + item.i;
        img.onerror = () => { img.remove(); tile.textContent = item.type === 'video' ? '▶' : '▧'; };
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = item.name;
        tile.append(img, badge);
        tile.onclick = async () => {
          const r = await fetch('/api/queue?t=' + TOKEN, {
            method: 'POST', body: JSON.stringify({ index: item.i }),
          });
          if (r.ok) { tile.classList.add('queued'); poll(); }
        };
        grid.appendChild(tile);
      }
      browseOffset += page.items.length;
      $('browse-more').style.display =
        (browseOffset < browseTotal && page.items.length > 0) ? '' : 'none';
    }

    $('browse-btn').onclick = () => {
      $('browse').classList.add('open');
      if (grid.children.length === 0) loadBrowsePage();
    };
    $('browse-close').onclick = () => $('browse').classList.remove('open');
    $('browse-more').onclick = () => loadBrowsePage();

    // Guest uploads: raw body per file, filename in the query string
    $('upload').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      const status = $('upload-status');
      let done = 0;
      for (const file of files) {
        status.textContent = 'Uploading ' + (done + 1) + ' / ' + files.length + '…';
        try {
          const res = await fetch('/api/upload?t=' + TOKEN + '&name=' + encodeURIComponent(file.name), {
            method: 'POST', body: file,
          });
          if (res.ok) done++;
          else status.textContent = (await res.text()) || 'Upload failed';
        } catch { status.textContent = 'Upload failed'; }
      }
      if (done > 0) status.textContent = done + ' photo' + (done > 1 ? 's' : '') + ' joined the show 🎉';
      e.target.value = '';
    });
  </script>
</body></html>`;

function lanAddress(): string | null {
    for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) {
            if (info.family === 'IPv4' && !info.internal) return info.address;
        }
    }
    return null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(null));
    });
}

let server: http.Server | null = null;
let currentUrl: string | null = null;

export function getRemoteUrl(): string | null {
    return currentUrl;
}

export async function startRemoteServer(callbacks: RemoteCallbacks): Promise<string> {
    if (server && currentUrl) return currentUrl;

    const token = generateToken();
    const page = PAGE.replace(/__TOKEN__/g, token);
    const throttle = new AuthThrottle();
    const budget = new UploadBudget({
        maxFiles: MAX_SESSION_UPLOAD_FILES,
        maxTotalBytes: MAX_SESSION_UPLOAD_BYTES,
    });

    server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const client = clientKey(req.socket.remoteAddress);

        // A wrong token from a client that has been guessing costs it a
        // cooldown, so the token cannot be enumerated at request speed.
        const retryAfterMs = throttle.retryAfterMs(client);
        if (retryAfterMs > 0) {
            res.writeHead(429, { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) });
            res.end('Too many attempts');
            return;
        }
        if (!safeTokenCompare(url.searchParams.get('t'), token)) {
            throttle.recordFailure(client);
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        throttle.recordSuccess(client);

        try {
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(page);
            } else if (req.method === 'GET' && url.pathname === '/api/status') {
                // Strip server-side fields; clients never see paths
                const { name, index, total, playing, favorite, queued } = callbacks.getStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ name, index, total, playing, favorite, queued }));
            } else if (req.method === 'GET' && url.pathname === '/api/library') {
                const offset = parseIndex(url.searchParams.get('offset')) ?? 0;
                const requested = parseIndex(url.searchParams.get('limit')) ?? MAX_LIBRARY_PAGE;
                const page = callbacks.getLibrary(offset, Math.min(requested, MAX_LIBRARY_PAGE));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(page));
            } else if (req.method === 'POST' && url.pathname === '/api/queue') {
                const body = await readBody(req, 4096);
                const { index } = JSON.parse(body?.toString() ?? '{}') as { index?: unknown };
                // Only ever an integer index into the list the renderer
                // published; a client can still never name a path.
                const wanted = typeof index === 'number' ? parseIndex(String(index)) : null;
                if (wanted !== null && callbacks.queueSlide(wanted)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                } else {
                    res.writeHead(400);
                    res.end('Unknown slide');
                }
            } else if (req.method === 'GET' && url.pathname === '/api/thumb') {
                // With ?i= it serves that slide (for the browse grid); without,
                // whatever is on screen now.
                const wanted = parseIndex(url.searchParams.get('i'));
                const thumb = wanted === null
                    ? await callbacks.getThumb()
                    : await callbacks.getThumbAt(wanted);
                if (thumb) {
                    res.writeHead(200, { 'Content-Type': thumb.type, 'Cache-Control': 'no-store' });
                    res.end(thumb.buffer);
                } else {
                    res.writeHead(404);
                    res.end();
                }
            } else if (req.method === 'POST' && url.pathname === '/api/action') {
                const body = await readBody(req, 4096);
                const { action } = JSON.parse(body?.toString() ?? '{}') as { action?: string };
                if (action && ALLOWED_ACTIONS.has(action)) {
                    callbacks.dispatchAction(action);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                } else {
                    res.writeHead(400);
                    res.end('Unknown action');
                }
            } else if (req.method === 'POST' && url.pathname === '/api/react') {
                const body = await readBody(req, 4096);
                const { emoji } = JSON.parse(body?.toString() ?? '{}') as { emoji?: string };
                if (emoji && ALLOWED_REACTIONS.has(emoji)) {
                    callbacks.sendReaction(emoji);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                } else {
                    res.writeHead(400);
                    res.end('Unknown reaction');
                }
            } else if (req.method === 'POST' && url.pathname === '/api/upload') {
                const name = url.searchParams.get('name') ?? '';
                const data = await readBody(req, MAX_UPLOAD_BYTES);
                if (!data || data.length === 0) {
                    res.writeHead(413);
                    res.end('File too large or empty');
                    return;
                }
                const reservation = budget.tryReserve(data.length);
                if (!reservation.ok) {
                    res.writeHead(507);
                    res.end(reservation.error);
                    return;
                }
                const result = await callbacks.saveUpload(name, data);
                if (!result.ok) budget.release(data.length); // rejected: don't spend the budget
                if (result.ok) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                } else {
                    res.writeHead(400);
                    res.end(result.error ?? 'Upload rejected');
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        } catch (e) {
            console.error('Remote server error:', e);
            res.writeHead(500);
            res.end();
        }
    });

    await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '0.0.0.0', resolve); // OS-assigned port
    });

    const port = (server.address() as AddressInfo).port;
    currentUrl = `http://${lanAddress() ?? '127.0.0.1'}:${port}/?t=${token}`;
    return currentUrl;
}

export function stopRemoteServer(): void {
    server?.close();
    server = null;
    currentUrl = null;
}

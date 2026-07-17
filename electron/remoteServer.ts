import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * LAN remote control + party features: a token-guarded HTTP server serving
 * a mobile page with transport controls, a live thumbnail of the current
 * slide (swipe to navigate), emoji reactions that float over the show, and
 * guest photo uploads that join the running slideshow.
 *
 * Security shape: every request needs the per-session token; the client can
 * never supply a filesystem path (the thumbnail endpoint takes no arguments
 * and serves whatever slide is current); uploads are extension-whitelisted,
 * size-capped, filename-sanitized, and written only under <root>/guests.
 */

export interface RemoteStatus {
    name: string | null;
    index: number | null;
    total: number;
    playing: boolean;
    favorite: boolean;
    /** Absolute path of the current file (server-side use only, never sent to clients). */
    path: string | null;
    /** First session root — uploads land in <root>/guests. */
    root: string | null;
}

export interface RemoteCallbacks {
    getStatus: () => RemoteStatus;
    dispatchAction: (action: string) => void;
    sendReaction: (emoji: string) => void;
    /** Thumbnail of the current slide, or null when it has none (video/none). */
    getThumb: () => Promise<{ buffer: Buffer; type: string } | null>;
    saveUpload: (name: string, data: Buffer) => Promise<{ ok: boolean; error?: string }>;
}

const ALLOWED_ACTIONS = new Set(['next', 'prev', 'toggle-play', 'favorite']);
const ALLOWED_REACTIONS = new Set(['🎉', '❤️', '😂', '👏', '🔥']);
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

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
  <label id="upload-label">＋ Add your photos to the show
    <input id="upload" type="file" accept="image/*,video/*" multiple>
  </label>
  <div id="upload-status"></div>
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

    const token = crypto.randomBytes(4).toString('hex');
    const page = PAGE.replace(/__TOKEN__/g, token);

    server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.searchParams.get('t') !== token) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        try {
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(page);
            } else if (req.method === 'GET' && url.pathname === '/api/status') {
                // Strip server-side fields; clients never see paths
                const { name, index, total, playing, favorite } = callbacks.getStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ name, index, total, playing, favorite }));
            } else if (req.method === 'GET' && url.pathname === '/api/thumb') {
                const thumb = await callbacks.getThumb();
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
                const result = await callbacks.saveUpload(name, data);
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

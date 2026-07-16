import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * LAN remote control: a tiny token-guarded HTTP server serving a mobile
 * control page. Actions are forwarded to the renderer over the same
 * menu:action channel the Actions menu uses; the renderer pushes playback
 * status back so the page can display it.
 */

export interface RemoteStatus {
    name: string | null;
    index: number | null;
    total: number;
    playing: boolean;
    favorite: boolean;
}

const ALLOWED_ACTIONS = new Set(['next', 'prev', 'toggle-play', 'favorite']);

// prev/next/play/favorite only — nothing filesystem-shaped is reachable here
const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>photo-slap remote</title>
<style>
  body { background: #111; color: #fff; font-family: ui-monospace, monospace;
         display: flex; flex-direction: column; align-items: center; gap: 22px;
         padding: 40px 16px; text-align: center; }
  h2 { letter-spacing: 2px; text-shadow: 2px 2px 0 #ff004c; margin: 0; }
  #name { color: #00aaff; word-break: break-all; min-height: 1.2em; }
  #count { color: #888; }
  .row { display: flex; gap: 14px; }
  button { font-size: 30px; padding: 22px 30px; background: #1a1a1a; color: #fff;
           border: 3px solid #444; border-radius: 0; }
  button:active { background: #00aaff; border-color: #fff; }
  #fav.on { color: #ff004c; border-color: #ff004c; }
</style></head>
<body>
  <h2>PHOTO-SLAP</h2>
  <div id="name">…</div>
  <div id="count"></div>
  <div class="row">
    <button data-action="prev">⏮</button>
    <button data-action="toggle-play" id="play">▶</button>
    <button data-action="next">⏭</button>
  </div>
  <div class="row"><button data-action="favorite" id="fav">♥</button></div>
  <script>
    const TOKEN = '__TOKEN__';
    const send = (action) => fetch('/api/action?t=' + TOKEN, {
      method: 'POST', body: JSON.stringify({ action }),
    }).then(() => setTimeout(poll, 300));
    document.querySelectorAll('button').forEach(b => b.onclick = () => send(b.dataset.action));
    async function poll() {
      try {
        const s = await (await fetch('/api/status?t=' + TOKEN)).json();
        document.getElementById('name').textContent = s.name ?? '—';
        document.getElementById('count').textContent = s.index != null ? s.index + ' / ' + s.total : '';
        document.getElementById('play').textContent = s.playing ? '⏸' : '▶';
        document.getElementById('fav').classList.toggle('on', !!s.favorite);
      } catch { /* app closed */ }
    }
    setInterval(poll, 2000);
    poll();
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

let server: http.Server | null = null;
let currentUrl: string | null = null;

export function getRemoteUrl(): string | null {
    return currentUrl;
}

export async function startRemoteServer(
    getStatus: () => RemoteStatus,
    dispatchAction: (action: string) => void,
): Promise<string> {
    if (server && currentUrl) return currentUrl;

    const token = crypto.randomBytes(4).toString('hex');
    const page = PAGE.replace(/__TOKEN__/g, token);

    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.searchParams.get('t') !== token) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(page);
        } else if (req.method === 'GET' && url.pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getStatus()));
        } else if (req.method === 'POST' && url.pathname === '/api/action') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const { action } = JSON.parse(body) as { action?: string };
                    if (action && ALLOWED_ACTIONS.has(action)) {
                        dispatchAction(action);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end('{"ok":true}');
                    } else {
                        res.writeHead(400);
                        res.end('Unknown action');
                    }
                } catch {
                    res.writeHead(400);
                    res.end('Bad request');
                }
            });
        } else {
            res.writeHead(404);
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

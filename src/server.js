'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// The local HTTP surface. Three clients talk to it:
//   - the UI (Electron overlay window or a browser tab): GET /api/events (SSE)
//   - agent hooks (Claude Code, `exhale run`): POST /api/agent/*, /api/hook
//   - the settings / consent screen: POST /api/consent, /api/history
//
// It is meant for this machine only. Defences, because any web page you
// visit can try to POST to localhost:
//   - every POST needs the `X-Exhale: 1` header (a cross-site page cannot
//     add it without a CORS preflight, which this server never approves)
//   - a browser Origin, if present, must be this server's own origin
//   - the Host header must be a loopback name (blocks DNS rebinding)

const UI_DIR = path.join(__dirname, 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

// Map a Claude Code hook payload (read from the hook's stdin) to a run.
function handleHook(session, body) {
  const id = body.session_id || 'claude-code';
  session.lastHookAt = Date.now();
  switch (body.hook_event_name) {
    case 'UserPromptSubmit':
      session.agentStart({ id, label: 'Claude Code' });
      return 'start';
    case 'Stop':
    case 'SessionEnd':
      session.agentStop({ id });
      return 'stop';
    default:
      return 'ignored';
  }
}

function createServer({
  session, settings, meta = {}, tickMs = 100, allowAnyHost = false, shell = {},
  listCameras = async () => [],
}) {
  const clients = new Set();
  let lastPush = 0;

  const state = () => ({ ...session.snapshot(), settings: settings.public(), meta });

  function broadcast() {
    lastPush = Date.now();
    const data = `data: ${JSON.stringify(state())}\n\n`;
    for (const res of clients) res.write(data);
  }

  session.on('change', broadcast);
  session.on('summary', (s) => settings.appendSummary(s));

  const ticker = setInterval(() => {
    session.tick();
    // Stream the live waveform ~5x/second while measuring.
    if (session.mode === 'active' && Date.now() - lastPush >= 200) broadcast();
  }, tickMs);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host || '';
    if (process.env.EXHALE_DEBUG && req.method !== 'GET') {
      console.log(`[exhale] ${req.method} ${url.pathname} mode=${session.mode}`);
    }
    if (!allowAnyHost && !LOOPBACK.test(host)) return send(res, 403, { error: 'host not allowed' });

    if (req.method === 'POST' || req.method === 'DELETE') {
      if (req.headers['x-exhale'] !== '1') return send(res, 403, { error: 'missing X-Exhale header' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'origin not allowed' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }

      if (req.method === 'POST' && url.pathname === '/api/agent/start') {
        const body = await readBody(req);
        const maxMs = Number(body.maxMs) > 0 ? Math.min(Number(body.maxMs), 600_000) : undefined;
        const id = session.agentStart({ id: body.id, label: body.label, maxMs });
        return send(res, 200, { id });
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/stop') {
        const body = await readBody(req);
        session.agentStop({ id: body.id });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/hook') {
        const body = await readBody(req);
        return send(res, 200, { action: handleHook(session, body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/shell') {
        // Desktop-only actions (open the Exhale window, quit the app).
        const body = await readBody(req);
        const fn = shell[body.action];
        if (!fn) return send(res, 404, { error: 'not available here' });
        send(res, 200, { ok: true });
        setImmediate(fn);
        return undefined;
      }
      if (req.method === 'POST' && url.pathname === '/api/dismiss') {
        session.dismiss();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/consent') {
        const body = await readBody(req);
        if (body.granted === true) { settings.grantConsent(); session.consentGranted(); }
        else { settings.revokeConsent(); session.consentRevoked(); }
        broadcast();
        return send(res, 200, settings.public());
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        if (typeof body.keepHistory === 'boolean') settings.setKeepHistory(body.keepHistory);
        if ('cameraId' in body) settings.setCameraId(typeof body.cameraId === 'string' ? body.cameraId : null);
        broadcast();
        return send(res, 200, settings.public());
      }
      if (req.method === 'GET' && url.pathname === '/api/cameras') {
        return send(res, 200, await listCameras());
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        return send(res, 200, settings.readHistory());
      }
      if (req.method === 'DELETE' && url.pathname === '/api/history') {
        settings.deleteHistory();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/data') {
        session.consentRevoked();
        settings.deleteAll();
        broadcast();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET') return serveStatic(url.pathname, res);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    async close() {
      clearInterval(ticker);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    });
    return res.end(buf);
  });
  return undefined;
}

module.exports = { createServer, handleHook };

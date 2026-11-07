'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startApp } = require('../src/app');
const { toFrame } = require('../src/engine/sdk-engine');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'exhale-test-')); }

async function boot(extra = {}) {
  return startApp({
    source: 'fake', port: 0, graceMs: 100, summaryMs: 60_000, dataDir: tmpDir(),
    fake: { warmupSec: 0.5, rampSec: 2 }, ...extra,
  });
}

const H = { 'content-type': 'application/json', 'x-exhale': '1' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('agent API drives the session end to end (fake sensor)', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  await fetch(`${app.url}/api/consent`, { method: 'POST', headers: H, body: '{"granted":true}' });

  const { id } = await (await fetch(`${app.url}/api/agent/start`, {
    method: 'POST', headers: H, body: '{"label":"npm test"}',
  })).json();
  await wait(1500);
  let s = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(s.mode, 'active');
  assert.equal(s.cameraOn, true);
  assert.ok(s.trace.length > 10, 'waveform is streaming');
  assert.equal(s.meta.source, 'fake');

  await fetch(`${app.url}/api/agent/stop`, { method: 'POST', headers: H, body: JSON.stringify({ id }) });
  s = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(s.mode, 'summary');
  assert.equal(s.cameraOn, false);
  assert.equal(s.summary.label, 'npm test');
});

test('Claude Code hook payloads map to start/stop', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const hook = (ev) => fetch(`${app.url}/api/hook`, {
    method: 'POST', headers: H, body: JSON.stringify({ session_id: 'abc', hook_event_name: ev }),
  }).then((r) => r.json());
  assert.equal((await hook('UserPromptSubmit')).action, 'start');
  assert.equal(app.session.runs.has('abc'), true);
  assert.equal((await hook('PreToolUse')).action, 'ignored');
  assert.equal((await hook('Stop')).action, 'stop');
  assert.equal(app.session.runs.size, 0);
});

test('CSRF and DNS-rebinding defences', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const noHeader = await fetch(`${app.url}/api/agent/start`, { method: 'POST' });
  assert.equal(noHeader.status, 403);
  const evilOrigin = await fetch(`${app.url}/api/agent/start`, {
    method: 'POST', headers: { ...H, origin: 'https://evil.example' },
  });
  assert.equal(evilOrigin.status, 403);
  const sameOrigin = await fetch(`${app.url}/api/agent/start`, {
    method: 'POST', headers: { ...H, origin: app.url.replace('127.0.0.1', '127.0.0.1') },
  });
  assert.equal(sameOrigin.status, 200);
  // fetch() drops a custom Host header, so use a raw request.
  const rebindingStatus = await new Promise((resolve, reject) => {
    require('http').get({
      host: '127.0.0.1', port: app.port, path: '/api/state', headers: { host: 'evil.example' },
    }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal(app.session.runs.size, 1);
});

test('static UI is served with a CSP, and path traversal is refused', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const res = await fetch(`${app.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await res.text(), /<title>Exhale<\/title>/);
  const bad = await fetch(`${app.url}/..%2f..%2fpackage.json`);
  assert.equal(bad.status, 404);
});

test('history is off by default, opt-in stores summaries only, delete wipes it', async (t) => {
  const app = await boot({ summaryMs: 10 });
  t.after(() => app.close());
  const run = async () => {
    await fetch(`${app.url}/api/agent/start`, { method: 'POST', headers: H, body: '{"id":"r"}' });
    await wait(400);
    await fetch(`${app.url}/api/agent/stop`, { method: 'POST', headers: H, body: '{"id":"r"}' });
  };
  await fetch(`${app.url}/api/consent`, { method: 'POST', headers: H, body: '{"granted":true}' });
  await run();
  assert.deepEqual(await (await fetch(`${app.url}/api/history`)).json(), []);
  assert.equal(fs.existsSync(app.settings.historyFile), false);

  await fetch(`${app.url}/api/settings`, { method: 'POST', headers: H, body: '{"keepHistory":true}' });
  await wait(50);
  await run();
  const hist = await (await fetch(`${app.url}/api/history`)).json();
  assert.equal(hist.length, 1);
  assert.deepEqual(Object.keys(hist[0]).sort(), [
    'agentSec', 'breathingEnd', 'breathingStart', 'endedAt', 'guidePacePerMin', 'guidedSec',
    'inSyncSec', 'label', 'lookAwayNudges', 'syncPct',
  ]);

  await fetch(`${app.url}/api/data`, { method: 'DELETE', headers: H });
  assert.equal(fs.existsSync(app.settings.historyFile), false);
  assert.equal(fs.existsSync(app.settings.file), false);
  assert.equal(app.settings.hasConsent, false);
});

test('`exhale run` wraps a command, keeps its exit code, and reports start/stop', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const bin = path.join(__dirname, '..', 'bin', 'exhale.js');
  const child = spawn(process.execPath, [bin, 'run', '--', process.execPath, '-e', 'setTimeout(()=>process.exit(3),600)'], {
    env: { ...process.env, EXHALE_URL: app.url },
  });
  await wait(300);
  assert.equal(app.session.runs.size, 1, 'run registered while the command runs');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 3);
  assert.equal(app.session.runs.size, 0);
});

test('`exhale run` still works when Exhale is not running', async () => {
  const bin = path.join(__dirname, '..', 'bin', 'exhale.js');
  const child = spawn(process.execPath, [bin, 'run', '--', process.execPath, '-e', 'process.exit(0)'], {
    env: { ...process.env, EXHALE_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(await new Promise((r) => child.on('exit', r)), 0);
});

test('SDK protobuf metrics decode into Exhale frames', () => {
  const { Metrics, decodeMetrics } = require('@smartspectra/node-sdk/messages');
  const ts = 1_700_000_000_000_000;
  const buf = Metrics.encode(Metrics.fromObject({
    breathing: {
      upperTrace: [{ value: 0.25, stable: true, timestamp: ts }],
      rate: [{ value: 7.5, stable: true, confidence: 80, timestamp: ts }],
    },
    face: {
      blinking: [{ detected: true, stable: true, timestamp: ts }],
      talking: [{ detected: false, stable: true, timestamp: ts }],
    },
  })).finish();
  const f = toFrame(decodeMetrics(Buffer.from(buf)));
  assert.equal(f.trace[0].t, 1_700_000_000);
  assert.equal(f.trace[0].v, 0.25);
  assert.equal(f.rate[0].value, 7.5);
  assert.equal(f.rate[0].stable, true);
  assert.equal(f.blinks[0].detected, true);
  assert.equal(f.talking[0].detected, false);
});

test('SdkEngine delivers frames even though the SDK keeps one listener per event', async () => {
  const { SdkEngine } = require('../src/engine/sdk-engine');
  const handlers = {};
  class OneListenerSDK {
    on(ev, cb) { handlers[ev] = cb; return this; } // later on() replaces earlier, like the real SDK
    useCamera() { return this; }
    useFile() { return this; }
    start() {}
    async stopAsync() {}
    async destroy() {}
    static availableCameras() { return [{ id: 'cam', name: 'Cam' }]; }
  }
  const engine = new SdkEngine({ apiKey: 'test', source: 'camera' });
  engine._lib = () => ({
    SmartSpectraSDK: OneListenerSDK,
    decodeMetrics: (b) => b,
    SmartSpectraLogLevel: { kError: 3 },
    ProcessingStatus: { kIdle: 1 },
    CameraSelection: { default: { kind: 'default' }, byId: (id) => ({ kind: 'byId', id }) },
  });
  const frames = [];
  engine.on('frame', (f) => frames.push(f));
  await engine.start();
  handlers.metrics({ breathing: { upperTrace: [{ value: 0.5, timestamp: 2_000_000 }] } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].trace[0].v, 0.5);
  await engine.stop();
});

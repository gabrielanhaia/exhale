'use strict';

const fs = require('fs');
const path = require('path');
const { Session } = require('./core/session');
const { Settings } = require('./settings');
const { createServer } = require('./server');
const { FakeEngine } = require('./engine/fake-engine');
const { ProcessEngine } = require('./engine/process-engine');

// Reads KEY=value lines from .env without overriding the real environment.
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function config(overrides = {}) {
  loadEnv();
  const env = process.env;
  return {
    source: env.EXHALE_SOURCE || 'camera',          // camera | file | fake
    file: env.EXHALE_FILE || null,
    cameraId: env.EXHALE_CAMERA_ID || null,
    apiKey: env.SMARTSPECTRA_API_KEY || null,
    port: Number(env.EXHALE_PORT || 7777),
    host: env.EXHALE_HOST || '127.0.0.1',
    graceMs: Number(env.EXHALE_GRACE_MS || 10_000),
    summaryMs: Number(env.EXHALE_SUMMARY_MS || 15_000),
    // In Docker the port is published on the host's loopback, but the
    // request still arrives with Host: localhost:<port>, which passes.
    allowAnyHost: env.EXHALE_ALLOW_ANY_HOST === '1',
    fake: env.EXHALE_FAKE_WARMUP_SEC ? { warmupSec: Number(env.EXHALE_FAKE_WARMUP_SEC) } : {},
    ...overrides,
  };
}

function makeEngine(cfg, settings) {
  if (cfg.source === 'fake') return new FakeEngine(cfg.fake || {});
  if (cfg.source === 'file' && !cfg.file) throw new Error('EXHALE_FILE is required for source=file');
  return new ProcessEngine({
    apiKey: cfg.apiKey, source: cfg.source, file: cfg.file, loop: true,
    getCameraId: () => cfg.cameraId || settings.data.cameraId,
  });
}

async function startApp(overrides = {}) {
  const cfg = config(overrides);
  const settings = new Settings(cfg.dataDir);
  const engine = cfg.engine || makeEngine(cfg, settings);
  const session = new Session({
    engine,
    graceMs: cfg.graceMs,
    summaryMs: cfg.summaryMs,
    hasConsent: () => settings.hasConsent,
  });
  const shell = cfg.shell || {};
  const meta = { source: cfg.source, graceMs: cfg.graceMs, desktop: Object.keys(shell).length > 0 };
  const listCameras = cfg.source === 'camera' ? () => ProcessEngine.listCameras()
    : async () => [];
  const app = createServer({
    session, settings, meta, shell, listCameras, allowAnyHost: cfg.allowAnyHost,
  });
  const port = await app.listen(cfg.port, cfg.host);
  const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${port}`;
  return {
    cfg, settings, session, engine, port, url,
    async close() {
      await engine.stop().catch(() => {});
      await app.close();
    },
  };
}

module.exports = { startApp, config, loadEnv };

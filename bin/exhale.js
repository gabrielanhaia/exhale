#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const USAGE = `exhale — a breathing guide while your coding agent works

  exhale serve                 start the local engine + UI (http://127.0.0.1:7777)
  exhale run -- <command...>   run any command; the guide shows while it runs
  exhale hooks                 print the Claude Code hooks to paste into settings
  exhale replay <video.mp4>    feed a recorded clip through the real SDK, print what it saw

  env: EXHALE_SOURCE=camera|file|fake  EXHALE_FILE  EXHALE_PORT  SMARTSPECTRA_API_KEY`;

const PORT = Number(process.env.EXHALE_PORT || 7777);
const BASE = process.env.EXHALE_URL || `http://127.0.0.1:${PORT}`;

async function post(p, body) {
  try {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-exhale': '1' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(1500),
    });
    return await res.json();
  } catch {
    return null; // Exhale not running: never get in the way of the command
  }
}

async function serve() {
  const { startApp } = require('../src/app');
  const app = await startApp();
  console.log(`exhale: ${app.cfg.source} source, UI at ${app.url}`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function run(argv) {
  const sep = argv.indexOf('--');
  const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
  if (!cmd.length) { console.error('usage: exhale run -- <command...>'); process.exit(2); }
  const started = await post('/api/agent/start', { label: path.basename(cmd[0]) });
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  const forward = (sig) => child.kill(sig);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.on('error', async (e) => {
    console.error(`exhale: ${e.message}`);
    if (started) await post('/api/agent/stop', { id: started.id });
    process.exit(127);
  });
  child.on('exit', async (code, signal) => {
    if (started) await post('/api/agent/stop', { id: started.id });
    process.exit(signal ? 1 : code ?? 0);
  });
}

function hooks() {
  const cmd = `curl -s -m 1 -X POST -H 'X-Exhale: 1' -H 'Content-Type: application/json' `
    + `--data-binary @- http://127.0.0.1:${PORT}/api/hook >/dev/null 2>&1 || true`;
  const hook = [{ hooks: [{ type: 'command', command: cmd }] }];
  const settings = { hooks: { UserPromptSubmit: hook, Stop: hook, SessionEnd: hook } };
  console.log(JSON.stringify(settings, null, 2));
  console.error('\nMerge this into ~/.claude/settings.json (or .claude/settings.json in a project).');
}

async function replay(file) {
  if (!file) { console.error('usage: exhale replay <video.mp4>'); process.exit(2); }
  const { loadEnv } = require('../src/app');
  const { SdkEngine } = require('../src/engine/sdk-engine');
  loadEnv();
  const engine = new SdkEngine({
    apiKey: process.env.SMARTSPECTRA_API_KEY, source: 'file', file: path.resolve(file),
  });
  const seen = { traceSamples: 0, rates: [], blinks: 0, talkingFrames: 0, validation: new Set() };
  let lastBlink = false;
  engine.on('frame', (f) => {
    seen.traceSamples += f.trace.length;
    for (const r of f.rate) if (r.stable) seen.rates.push(Math.round(r.value * 10) / 10);
    for (const b of f.blinks) { if (b.detected && !lastBlink) seen.blinks++; lastBlink = b.detected; }
    seen.talkingFrames += f.talking.filter((t) => t.detected).length;
  });
  engine.on('validation', (c) => seen.validation.add(c));
  let failed = null;
  const done = new Promise((resolve) => {
    engine.on('error', (e) => {
      failed = e;
      console.error(`SDK error ${e.code}: ${e.message}`);
      resolve();
    });
    let running = false;
    engine.on('status', (s) => {
      if (s === 'running') running = true;
      if (running && (s === 'idle' || s === 'error')) resolve();
    });
  });
  await engine.start();
  await done;
  await engine.stop();
  const out = {
    traceSamples: seen.traceSamples,
    stableBreathingRates: seen.rates.length,
    breathingRateFirst: seen.rates[0] ?? null,
    breathingRateLast: seen.rates.at(-1) ?? null,
    blinks: seen.blinks,
    talkingFrames: seen.talkingFrames,
    validationCodes: [...seen.validation],
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(failed || !out.traceSamples ? 1 : 0);
}

const [, , sub, ...rest] = process.argv;
({
  serve, run: () => run(rest), hooks, replay: () => replay(rest[0]),
}[sub] || (() => { console.log(USAGE); process.exit(sub ? 2 : 0); }))();

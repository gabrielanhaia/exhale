'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Session } = require('../src/core/session');
const { guideAt } = require('../src/core/pacer');

class StubEngine extends EventEmitter {
  constructor() { super(); this.running = false; this.starts = 0; this.stops = 0; }
  async start() { this.running = true; this.starts++; }
  async stop() { this.running = false; this.stops++; }
}

function setup({ consent = true, graceMs = 1000 } = {}) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const engine = new StubEngine();
  let hasConsent = consent;
  const s = new Session({
    engine, clock, graceMs, summaryMs: 5000, hasConsent: () => hasConsent,
  });
  const advance = (ms) => { now += ms; s.tick(); };
  const flush = () => new Promise((r) => setImmediate(r));
  return { s, engine, advance, flush, clock, grant: () => { hasConsent = true; } };
}

// Feed `sec` seconds of a person following the guide, 1 s at a time.
function feedFollowing(ctx, sec, { rate = 6, blinkEvery = 4 } = {}) {
  const { s, advance, clock } = ctx;
  for (let i = 0; i < sec; i++) {
    const end = clock() / 1000 + 1;
    const trace = [];
    const blinks = [];
    for (let t = clock() / 1000; t < end; t += 1 / 30) {
      trace.push({ t, v: guideAt(t - s.guideStartSec - 0.8).value });
      const el = t - s.guideStartSec;
      blinks.push({ t, detected: (el % blinkEvery) < 0.12 });
    }
    const el = end - s.guideStartSec;
    s.engine.emit('frame', {
      trace, blinks, talking: [],
      rate: [{ t: end, value: rate, stable: el > 30, confidence: el > 30 ? 80 : 0 }],
    });
    advance(1000);
  }
}

test('short runs never turn the camera on', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  assert.equal(ctx.s.mode, 'pending');
  ctx.advance(500);
  ctx.s.agentStop({ id: 'a' });
  await ctx.flush();
  assert.equal(ctx.s.mode, 'idle');
  assert.equal(ctx.engine.starts, 0);
});

test('long run: pending → active (camera on) → summary → idle', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a', label: 'Claude Code' });
  ctx.advance(1000);
  await ctx.flush();
  assert.equal(ctx.s.mode, 'active');
  assert.equal(ctx.engine.running, true);
  assert.equal(ctx.s.snapshot().cameraOn, true);

  feedFollowing(ctx, 70);
  const live = ctx.s.snapshot();
  assert.ok(live.sync >= 90, `sync ${live.sync}`);
  assert.equal(live.breathingRate, 6);
  assert.equal(live.warmingUp, false);
  assert.ok(live.trace.length > 0 && live.trace.length <= 200);

  ctx.s.agentStop({ id: 'a' });
  await ctx.flush();
  assert.equal(ctx.s.mode, 'summary');
  assert.equal(ctx.engine.running, false, 'camera off as soon as the agent stops');
  const sum = ctx.s.snapshot().summary;
  assert.equal(sum.label, 'Claude Code');
  assert.equal(sum.agentSec, 71);
  assert.ok(sum.syncPct >= 90, `syncPct ${sum.syncPct}`);
  assert.equal(sum.breathingStart, 6);
  assert.equal(sum.lookAwayNudges, 0);

  ctx.advance(5000);
  assert.equal(ctx.s.mode, 'idle');
});

test('no consent: asks instead of starting the camera', async () => {
  const ctx = setup({ consent: false });
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  assert.equal(ctx.s.mode, 'consent');
  assert.equal(ctx.engine.starts, 0);
  ctx.grant();
  ctx.s.consentGranted();
  await ctx.flush();
  assert.equal(ctx.s.mode, 'active');
  assert.equal(ctx.engine.starts, 1);
});

test('dismiss turns the camera off and stays quiet until the run ends', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  ctx.s.dismiss();
  await ctx.flush();
  assert.equal(ctx.s.mode, 'snoozed');
  assert.equal(ctx.engine.running, false);
  ctx.advance(5000);
  assert.equal(ctx.s.mode, 'snoozed');
  ctx.s.agentStop({ id: 'a' });
  assert.equal(ctx.s.mode, 'idle');
  assert.equal(ctx.engine.starts, 1);
});

test('revoking consent mid-run turns the camera off', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  ctx.s.consentRevoked();
  await ctx.flush();
  assert.equal(ctx.engine.running, false);
  assert.equal(ctx.s.snapshot().cameraOn, false);
});

test('overlapping runs: the guide stays until the last one stops', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.s.agentStart({ id: 'b' });
  ctx.advance(1000);
  await ctx.flush();
  ctx.s.agentStop({ id: 'a' });
  assert.equal(ctx.s.mode, 'active');
  ctx.s.agentStop({ id: 'b' });
  assert.equal(ctx.s.mode, 'summary');
});

test('low blink rate shows a look-away nudge', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  feedFollowing(ctx, 60, { blinkEvery: 20 }); // 3 blinks a minute
  assert.equal(ctx.s.snapshot().lookAway, true);
  ctx.s.agentStop({ id: 'a' });
  assert.equal(ctx.s.snapshot().summary.lookAwayNudges, 1);
});

test('talking pauses the guide and is not scored', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  const t = ctx.clock() / 1000;
  ctx.s.engine.emit('frame', { trace: [], rate: [], blinks: [], talking: [{ t, detected: true }] });
  assert.equal(ctx.s.snapshot().talking, true);
  ctx.advance(3000);
  assert.equal(ctx.s.snapshot().talking, false);
});

test('replayed file timestamps that start at 0 are aligned to the wall clock', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  ctx.s.engine.emit('frame', { trace: [{ t: 0.5, v: 1 }], rate: [], blinks: [], talking: [] });
  const [[t]] = ctx.s.snapshot().trace;
  assert.ok(Math.abs(t - ctx.clock() / 1000) < 1);
});

test('engine start failure is surfaced, not swallowed', async () => {
  const ctx = setup();
  ctx.engine.start = async () => { const e = new Error('Camera access was denied'); e.code = 'permission'; throw e; };
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush(); await ctx.flush();
  assert.equal(ctx.s.snapshot().error.message, 'Camera access was denied');
  assert.equal(ctx.s.snapshot().cameraOn, false, 'never claims the camera is on');
  assert.equal(ctx.s.mode, 'snoozed');
});

test('test runs with maxMs end by themselves', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'try', maxMs: 5000 });
  ctx.advance(1000);
  await ctx.flush();
  assert.equal(ctx.s.mode, 'active');
  assert.equal(ctx.s.snapshot().testRun, true);
  ctx.advance(4000);
  assert.equal(ctx.s.mode, 'summary');
  await ctx.flush();
  assert.equal(ctx.engine.running, false);
});

test('Close on the camera-off card hides it', () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.s.dismiss();
  assert.equal(ctx.s.mode, 'snoozed');
  ctx.s.dismiss();
  assert.equal(ctx.s.mode, 'idle');
});

test('metric streams with different time bases all land on the wall clock', async () => {
  const ctx = setup();
  ctx.s.agentStart({ id: 'a' });
  ctx.advance(1000);
  await ctx.flush();
  const now = ctx.clock() / 1000;
  // blinks in epoch microseconds-as-seconds, trace in seconds since boot
  ctx.s.engine.emit('frame', { trace: [], rate: [], talking: [], blinks: [{ t: now, detected: false }] });
  ctx.s.engine.emit('frame', { trace: [{ t: 12.0, v: 1 }, { t: 12.1, v: 2 }], rate: [], blinks: [], talking: [] });
  const tr = ctx.s.snapshot().trace;
  assert.equal(tr.length, 2, 'trace kept even though its clock differs from the blink clock');
  assert.ok(Math.abs(tr[1][0] - now) < 0.01);
  assert.ok(Math.abs(tr[1][0] - tr[0][0] - 0.1) < 0.01, 'spacing preserved');
});

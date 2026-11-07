'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcessEngine } = require('../src/engine/process-engine');
const { Session } = require('../src/core/session');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a native crash in the SDK process ends the run, not the app', async () => {
  const engine = new ProcessEngine({ source: 'selftest', crashAfterMs: 300 });
  const session = new Session({ engine, graceMs: 0, hasConsent: () => true });
  let frames = 0;
  engine.on('frame', () => { frames++; });
  session.agentStart({ id: 'r' });
  session.tick();
  assert.equal(session.mode, 'active');
  await wait(1500);
  assert.equal(frames, 1, 'frames flowed before the crash');
  assert.equal(session.mode, 'snoozed', 'guide stopped');
  assert.equal(session.snapshot().cameraOn, false);
  assert.match(session.snapshot().error.message, /stopped unexpectedly/);
  assert.equal(engine.child, null);
});

test('a new run waits for the previous one to shut down, then starts clean', async () => {
  const engine = new ProcessEngine({ source: 'selftest', crashAfterMs: 5000 });
  await engine.start();
  const first = engine.child.pid;
  const stopping = engine.stop();
  await engine.start(); // must not overlap the old process
  await stopping;
  assert.notEqual(engine.child.pid, first, 'fresh process per run');
  await engine.stop();
  assert.equal(engine.child, null);
});

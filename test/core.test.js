'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guideAt, breathsPerMinute, DEFAULT_PACE } = require('../src/core/pacer');
const { syncScore, pearson } = require('../src/core/sync');
const { BlinkTracker } = require('../src/core/blinks');

test('pacer: 4s in / 6s out is 6 breaths per minute', () => {
  assert.equal(breathsPerMinute(DEFAULT_PACE), 6);
});

test('pacer: phases, turning points and wrap-around', () => {
  assert.equal(guideAt(0).phase, 'in');
  assert.ok(Math.abs(guideAt(0).value + 1) < 1e-9, 'starts empty');
  assert.ok(Math.abs(guideAt(4).value - 1) < 1e-9, 'full at end of inhale');
  assert.equal(guideAt(4).phase, 'out');
  assert.equal(guideAt(9.9).phase, 'out');
  assert.equal(guideAt(10).phase, 'in');
  assert.deepEqual(guideAt(23), guideAt(3));
  assert.deepEqual(guideAt(-7), guideAt(3));
});

function series(fromSec, toSec, hz, fn) {
  const out = [];
  for (let t = fromSec; t <= toSec; t += 1 / hz) out.push({ t, v: fn(t) });
  return out;
}

test('sync: a trace that follows the guide scores high, even inverted and late', () => {
  const g0 = 1000;
  const follow = series(g0, g0 + 30, 30, (t) => 5 + 2 * guideAt(t - g0 - 1).value);
  const inverted = series(g0, g0 + 30, 30, (t) => -guideAt(t - g0 - 0.6).value);
  const a = syncScore(follow, g0);
  const b = syncScore(inverted, g0);
  assert.ok(a.score > 0.95, `follow ${a.score}`);
  assert.equal(a.lagSec, 1);
  assert.ok(b.score > 0.95, `inverted ${b.score}`);
});

test('sync: breathing at your own pace scores low', () => {
  const g0 = 0;
  const own = series(0, 30, 30, (t) => Math.sin(2 * Math.PI * (16 / 60) * t));
  const s = syncScore(own, g0);
  assert.ok(s.score < 0.45, `own pace ${s.score}`);
});

test('sync: not enough data returns null', () => {
  assert.equal(syncScore([], 0), null);
  assert.equal(syncScore(series(0, 5, 30, Math.sin), 0), null);
});

test('pearson: perfect, inverse and flat', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-12);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0);
});

function blinkStream(tracker, fromSec, toSec, perMin) {
  const statuses = [];
  const every = 60 / perMin;
  let next = fromSec + every / 2;
  for (let t = fromSec; t < toSec; t += 1 / 30) {
    const closed = t >= next && t < next + 0.12;
    if (t >= next + 0.12) next += every;
    statuses.push({ t, detected: closed });
  }
  tracker.push(statuses);
}

test('blinks: counts rising edges, not frames', () => {
  const b = new BlinkTracker();
  blinkStream(b, 0, 60, 15);
  assert.equal(b.totalBlinks, 15);
  assert.ok(Math.abs(b.ratePerMin() - 15) <= 1);
});

test('blinks: no verdict before enough face time', () => {
  const b = new BlinkTracker();
  blinkStream(b, 0, 20, 2);
  assert.equal(b.ratePerMin(), null);
  assert.equal(b.shouldNudge(), false);
});

test('blinks: low rate nudges once, then respects the cooldown', () => {
  const b = new BlinkTracker();
  blinkStream(b, 0, 60, 4);
  assert.equal(b.shouldNudge(), true);
  assert.equal(b.shouldNudge(), false);
  blinkStream(b, 60, 200, 4);
  assert.equal(b.shouldNudge(), false, 'within 5 min cooldown');
  blinkStream(b, 200, 400, 4);
  assert.equal(b.shouldNudge(), true);
  assert.equal(b.nudges, 2);
});

test('blinks: a normal rate never nudges', () => {
  const b = new BlinkTracker();
  blinkStream(b, 0, 300, 15);
  assert.equal(b.shouldNudge(), false);
});

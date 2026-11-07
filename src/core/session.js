'use strict';

const { EventEmitter } = require('events');
const { BlinkTracker } = require('./blinks');
const { syncScore } = require('./sync');
const { DEFAULT_PACE, breathsPerMinute } = require('./pacer');

// The session state machine. One instance per app.
//
//   idle ──agentStart──▶ pending ──graceMs──▶ active ──last agentStop──▶ summary ──summaryMs──▶ idle
//                          │  (no consent yet) ▶ consent ──grant──▶ active
//                          └──dismiss──▶ snoozed ──last agentStop──▶ idle
//
// The camera is on only in `active`. Every other state has it off.

const IN_SYNC = 0.6;          // correlation at or above this counts as following
const TRACE_KEEP_SEC = 30;    // waveform kept in memory for the UI and scoring
const TALK_WINDOW_SEC = 1.5;  // talking = confident detections across most of this window
const TALK_MIN_RATIO = 0.6;

const VALIDATION_HINTS = {
  1: 'Looking for your face. Face the screen.',
  2: 'More than one face in view.',
  3: 'Center your face in the camera.',
  4: 'Move a little closer or further away.',
  5: 'Too dark. Turn on a light in front of you.',
  6: 'Too bright behind you.',
  7: 'Sit back a little so your shoulders are visible.',
  10: 'Camera is adjusting…',
  11: 'Your camera is sending too few frames, usually because the room is dark. Turn on a light facing you, or pick another camera in the Exhale window.',
  12: 'Hold still for a moment.',
  13: 'Move a little further from the camera.',
  14: 'Move a little closer to the camera.',
  15: 'Lower the camera or sit up.',
  16: 'Raise the camera or sit lower.',
  17: 'Face the screen.',
};

let nextId = 1;

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.engine = opts.engine;
    this.clock = opts.clock || Date.now;
    this.graceMs = opts.graceMs ?? 10_000;
    this.summaryMs = opts.summaryMs ?? 15_000;
    this.pace = opts.pace || DEFAULT_PACE;
    this.hasConsent = opts.hasConsent || (() => false);
    this.blinkOpts = opts.blinkOpts || {};
    this.runs = new Map();
    this.mode = 'idle';
    this.summary = null;
    this.error = null;
    this._resetMeasurement();

    this.engine.on('frame', (f) => this._onFrame(f));
    this.engine.on('validation', (code) => { this.validation = code; });
    this.engine.on('error', (err) => {
      this.error = { code: err.code, message: err.message };
      this.emit('change');
    });
    this.engine.on('status', (s) => { this.engineStatus = s; });
    // The sensor died mid-run (e.g. a native crash in the SDK process):
    // the camera is already gone, so say so and stop guiding.
    this.engine.on('fatal', (err) => {
      this.error = { code: err.code, message: err.message };
      if (this.mode === 'active') { this._stopEngine(); this.mode = 'snoozed'; }
      this.emit('change');
    });
  }

  _resetMeasurement() {
    this.trace = [];
    this.rates = [];
    this.blinks = new BlinkTracker(this.blinkOpts);
    this.talk = [];
    this.validation = null;
    this.engineStatus = 'off';
    this.sync = null;
    this.syncSeconds = 0;
    this.inSyncSeconds = 0;
    this.lastSyncEvalMs = 0;
    this.nudgeUntilMs = 0;
    this.activeSinceMs = null;
    this.guideStartSec = null;
  }

  nowSec() { return this.clock() / 1000; }

  // ---- inputs ------------------------------------------------------------

  // maxMs: end the run automatically (used by "Try it now" so a
  // forgotten test run can't keep the camera on and spend credits).
  agentStart({ id, label, maxMs } = {}) {
    const runId = String(id || `run-${nextId++}`);
    if (!this.runs.has(runId)) {
      this.runs.set(runId, {
        label: label || null, startedAt: this.clock(), endsAt: maxMs ? this.clock() + maxMs : null,
      });
    }
    if (this.mode === 'idle' || this.mode === 'summary') {
      this.summary = null;
      this.mode = 'pending';
      this.pendingSinceMs = this.clock();
      this.firstRunStartMs = this.clock();
      this.label = label || null;
    }
    this.emit('change');
    return runId;
  }

  agentStop({ id } = {}) {
    if (id && this.runs.has(String(id))) this.runs.delete(String(id));
    else if (!id) this.runs.clear();
    if (this.runs.size > 0) { this.emit('change'); return; }

    if (this.mode === 'active') this._finish();
    else if (['pending', 'consent', 'snoozed'].includes(this.mode)) this.mode = 'idle';
    this.emit('change');
  }

  // "Not now": camera off immediately, stay quiet until this run ends.
  dismiss() {
    if (this.mode === 'active') this._stopEngine();
    if (['active', 'pending', 'consent'].includes(this.mode)) this.mode = 'snoozed';
    else if (this.mode === 'summary' || this.mode === 'snoozed') this.mode = 'idle';
    this.emit('change');
  }

  consentGranted() {
    if (this.mode === 'consent') this._activate();
    this.emit('change');
  }

  // Revoking consent mid-run turns the camera off at once.
  consentRevoked() {
    if (this.mode === 'active') { this._stopEngine(); this.mode = 'snoozed'; }
    if (this.mode === 'consent') this.mode = 'snoozed';
    this.emit('change');
  }

  tick() {
    const now = this.clock();
    for (const [id, run] of this.runs) {
      if (run.endsAt && now >= run.endsAt) this.agentStop({ id });
    }
    if (this.mode === 'pending' && now - this.pendingSinceMs >= this.graceMs) {
      if (this.hasConsent()) this._activate();
      else this.mode = 'consent';
      this.emit('change');
    }
    if (this.mode === 'summary' && now - this.summaryAtMs >= this.summaryMs) {
      this.mode = 'idle';
      this.emit('change');
    }
    if (this.mode === 'active' && now - this.lastSyncEvalMs >= 1000) {
      this.lastSyncEvalMs = now;
      this._evaluate(now);
    }
  }

  // ---- internals ---------------------------------------------------------

  _activate() {
    this._resetMeasurement();
    this.error = null;
    this.mode = 'active';
    this.activeSinceMs = this.clock();
    this.guideStartSec = this.nowSec();
    this.engineStatus = 'starting';
    Promise.resolve()
      .then(() => this.engine.start())
      .catch((err) => {
        // The camera never came on: say so, and don't keep a guide
        // running that claims otherwise.
        this.error = { code: err.code ?? 'start', message: err.message };
        if (this.mode === 'active') { this.mode = 'snoozed'; this.engineStatus = 'off'; }
        this.emit('change');
      });
  }

  _stopEngine() {
    Promise.resolve()
      .then(() => this.engine.stop())
      .catch(() => { /* already stopped */ });
    this.engineStatus = 'off';
  }

  // Place a batch of samples on the wall clock by arrival time: the newest
  // sample is "now" and the others keep their spacing. The SDK's metric
  // streams do not share one time base (and a replayed file starts at 0),
  // so absolute timestamps are never compared with the clock.
  _anchor(samples) {
    if (!samples || !samples.length) return [];
    const now = this.nowSec();
    const last = samples[samples.length - 1].t;
    return samples.map((s) => ({ ...s, t: now - Math.max(0, last - s.t) }));
  }

  _onFrame(frame) {
    if (process.env.EXHALE_DEBUG && (this._dbg = (this._dbg || 0) + 1) % 30 === 1) {
      console.log('[session] frame', this.mode, JSON.stringify({
        trace: (frame.trace || []).slice(-2), rate: (frame.rate || []).slice(-1),
        blinks: (frame.blinks || []).length, now: this.nowSec(), kept: this.trace.length,
      }));
    }
    if (this.mode !== 'active') return;
    for (const s of this._anchor(frame.trace)) this.trace.push({ t: s.t, v: s.v });
    const cutoff = this.nowSec() - TRACE_KEEP_SEC;
    while (this.trace.length && this.trace[0].t < cutoff) this.trace.shift();

    for (const r of this._anchor(frame.rate)) {
      this.rates.push({ t: r.t, value: r.value, stable: r.stable });
    }
    const blinks = this._anchor(frame.blinks);
    if (blinks.length) this.blinks.push(blinks.map((b) => ({ t: b.t, detected: b.detected })));
    // The SDK's talking detector flickers on small mouth movements (breathing
    // through the mouth, a beard moving). Only confident detections count.
    for (const s of this._anchor(frame.talking)) {
      this.talk.push({ t: s.t, on: s.detected && s.stable !== false });
    }
    const cut = this.nowSec() - TALK_WINDOW_SEC * 2;
    while (this.talk.length && this.talk[0].t < cut) this.talk.shift();
  }

  // Talking only when most samples in the last 1.5 s say so, and there are
  // enough of them to judge (a single flicker never pauses the guide).
  isTalking() {
    const from = this.nowSec() - TALK_WINDOW_SEC;
    const recent = this.talk.filter((s) => s.t >= from);
    if (recent.length < 10) return false;
    return recent.filter((s) => s.on).length / recent.length >= TALK_MIN_RATIO;
  }

  _evaluate(nowMs) {
    this.sync = syncScore(this.trace, this.guideStartSec, { pace: this.pace });
    if (this.sync && !this.isTalking()) {
      this.syncSeconds++;
      if (this.sync.score >= IN_SYNC) this.inSyncSeconds++;
    }
    if (this.blinks.shouldNudge()) {
      this.nudgeUntilMs = nowMs + 20_000;
    }
    this.emit('change');
  }

  _stableRates() {
    return this.rates.filter((r) => r.stable);
  }

  _finish() {
    this._stopEngine();
    const now = this.clock();
    const stable = this._stableRates();
    this.summary = {
      label: this.label,
      agentSec: Math.round((now - this.firstRunStartMs) / 1000),
      guidedSec: Math.round((now - this.activeSinceMs) / 1000),
      guidePacePerMin: breathsPerMinute(this.pace),
      breathingStart: stable.length ? round1(stable[0].value) : null,
      breathingEnd: stable.length ? round1(stable[stable.length - 1].value) : null,
      syncPct: this.syncSeconds
        ? Math.round((this.inSyncSeconds / this.syncSeconds) * 100) : null,
      inSyncSec: this.inSyncSeconds,
      lookAwayNudges: this.blinks.nudges,
      endedAt: new Date(now).toISOString(),
    };
    this.mode = 'summary';
    this.summaryAtMs = now;
    this.emit('summary', this.summary);
  }

  // ---- output ------------------------------------------------------------

  snapshot() {
    const now = this.clock();
    const latestRate = this.rates.length ? this.rates[this.rates.length - 1] : null;
    const measuring = this.mode === 'active';
    return {
      mode: this.mode,
      cameraOn: measuring,
      agentsRunning: this.runs.size,
      label: this.label || null,
      pace: this.pace,
      guideStartMs: this.guideStartSec ? this.guideStartSec * 1000 : null,
      guideInMs: this.mode === 'pending' ? Math.max(0, this.pendingSinceMs + this.graceMs - now) : null,
      testRun: this.runs.has('try'),
      lastHookAt: this.lastHookAt || null,
      warmingUp: measuring && !(latestRate && latestRate.stable),
      engineStatus: this.engineStatus,
      breathingRate: latestRate && latestRate.stable ? round1(latestRate.value) : null,
      sync: measuring && this.sync ? Math.round(this.sync.score * 100) : null,
      traceSign: this.sync ? this.sync.sign : 1,
      inSyncSec: this.inSyncSeconds,
      talking: measuring && this.isTalking(),
      blinkRate: measuring && this.blinks.ratePerMin() !== null
        ? Math.round(this.blinks.ratePerMin()) : null,
      lookAway: measuring && now < this.nudgeUntilMs,
      hint: measuring && this.validation && this.validation !== 0
        ? VALIDATION_HINTS[this.validation] || null : null,
      trace: measuring ? downsample(this.trace, 200) : [],
      summary: this.mode === 'summary' ? this.summary : null,
      error: this.error,
    };
  }
}

function round1(x) { return Math.round(x * 10) / 10; }

function downsample(points, max) {
  if (points.length <= max) return points.map((p) => [round3(p.t), round3(p.v)]);
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.floor(i * step)];
    out.push([round3(p.t), round3(p.v)]);
  }
  return out;
}
function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = { Session, IN_SYNC, VALIDATION_HINTS };

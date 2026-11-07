'use strict';

const { EventEmitter } = require('events');
const { guideAt, DEFAULT_PACE } = require('../core/pacer');

// A stand-in for the camera, for tests, CI and the Docker demo on hosts
// where a container cannot reach the webcam. It produces the same frame
// shape as SdkEngine: a person who starts at ~15 breaths/min, gradually
// locks on to the guide, blinks less and less, and talks once.
//
// It is labelled "simulated" everywhere in the UI. It is never presented
// as a measurement.

class FakeEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      warmupSec: 30,       // the real SDK needs ~30s before a stable rate
      startRate: 15,
      rampSec: 60,         // time to lock on to the guide
      lagSec: 0.8,         // people follow a visual guide a little late
      startBlinksPerMin: 16,
      endBlinksPerMin: 4,
      blinkRampSec: 90,
      talkAtSec: [45],     // brief talking bursts (seconds from start)
      talkForSec: 4,
      tickMs: 100,
      pace: DEFAULT_PACE,
      clock: Date.now,
      ...opts,
    };
    this.timer = null;
  }

  async start() {
    if (this.timer) return;
    const o = this.opts;
    this.t0 = o.clock() / 1000;
    this.last = this.t0;
    this.freePhase = 0;
    this.nextBlinkAt = this.t0 + 2;
    this.blinkOpen = 0;
    this.emit('status', 'starting');
    this.emit('validation', 10);
    this.timer = setInterval(() => this._tick(), o.tickMs);
    setTimeout(() => {
      if (this.timer) { this.emit('status', 'running'); this.emit('validation', 0); }
    }, 300);
  }

  async stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('status', 'off');
  }

  _rateAt(el) {
    const o = this.opts;
    const target = 60 / (o.pace.inhaleSec + o.pace.exhaleSec);
    const k = Math.min(1, el / o.rampSec);
    return o.startRate + (target - o.startRate) * k;
  }

  _tick() {
    const o = this.opts;
    const now = o.clock() / 1000;
    const frame = { trace: [], rate: [], blinks: [], talking: [] };
    const step = 1 / 30;
    for (let t = this.last + step; t <= now; t += step) {
      const el = t - this.t0;
      const k = Math.min(1, el / o.rampSec);
      // free breathing at a drifting rate, blended into the guide shape
      this.freePhase += 2 * Math.PI * (this._rateAt(el) / 60) * step;
      const free = Math.sin(this.freePhase);
      const guided = guideAt(el - o.lagSec, o.pace).value;
      const v = (1 - k) * free + k * guided + 0.05 * Math.sin(t * 7.3);
      frame.trace.push({ t, v: 2 + v });

      if (t >= this.nextBlinkAt) {
        this.blinkOpen = 4; // ~130ms closed
        const bk = Math.min(1, el / o.blinkRampSec);
        const perMin = o.startBlinksPerMin + (o.endBlinksPerMin - o.startBlinksPerMin) * bk;
        this.nextBlinkAt = t + 60 / perMin;
      }
      frame.blinks.push({ t, detected: this.blinkOpen > 0 });
      if (this.blinkOpen > 0) this.blinkOpen--;

      const talking = o.talkAtSec.some((s) => el >= s && el < s + o.talkForSec);
      frame.talking.push({ t, detected: talking });
      this.last = t;
    }
    const el = now - this.t0;
    if (Math.floor(el) !== Math.floor(el - o.tickMs / 1000)) {
      frame.rate.push({
        t: now,
        value: this._rateAt(el),
        stable: el >= o.warmupSec,
        confidence: el >= o.warmupSec ? 80 : 0,
      });
    }
    this.emit('frame', frame);
  }
}

module.exports = { FakeEngine };

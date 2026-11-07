'use strict';

// Counts blinks from the SDK's per-frame blink detection and decides
// when to suggest a short look-away break.
//
// This is a screen-break reminder, not an eye-health measurement. The
// thresholds are deliberately simple and live in one place.

const DEFAULTS = Object.freeze({
  windowSec: 60,          // rolling window for the blink rate
  lowRatePerMin: 8,       // below this, suggest a look-away
  minObservedSec: 45,     // need this much face time before judging
  nudgeCooldownSec: 300,  // at most one nudge every 5 minutes
});

class BlinkTracker {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.blinkTimes = [];
    this.lastDetected = false;
    this.firstSeen = null;
    this.lastSeen = null;
    this.lastNudgeAt = -Infinity;
    this.totalBlinks = 0;
    this.nudges = 0;
  }

  // statuses: [{ t: seconds, detected: bool }], in time order.
  push(statuses) {
    for (const s of statuses) {
      if (this.firstSeen === null) this.firstSeen = s.t;
      this.lastSeen = s.t;
      if (s.detected && !this.lastDetected) {
        this.blinkTimes.push(s.t);
        this.totalBlinks++;
      }
      this.lastDetected = s.detected;
    }
    const cutoff = (this.lastSeen ?? 0) - this.opts.windowSec;
    while (this.blinkTimes.length && this.blinkTimes[0] < cutoff) {
      this.blinkTimes.shift();
    }
  }

  observedSec() {
    if (this.firstSeen === null) return 0;
    return this.lastSeen - this.firstSeen;
  }

  // Blinks per minute over the rolling window, or null if too early.
  ratePerMin() {
    const observed = this.observedSec();
    if (observed < this.opts.minObservedSec) return null;
    const span = Math.min(observed, this.opts.windowSec);
    return (this.blinkTimes.length / span) * 60;
  }

  // Returns true once when a look-away break should be suggested.
  shouldNudge() {
    const rate = this.ratePerMin();
    if (rate === null || rate >= this.opts.lowRatePerMin) return false;
    if (this.lastSeen - this.lastNudgeAt < this.opts.nudgeCooldownSec) {
      return false;
    }
    this.lastNudgeAt = this.lastSeen;
    this.nudges++;
    return true;
  }
}

module.exports = { BlinkTracker, BLINK_DEFAULTS: DEFAULTS };

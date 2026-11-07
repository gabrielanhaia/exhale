'use strict';

const { guideAt, DEFAULT_PACE } = require('./pacer');

// How closely does the measured breathing waveform follow the guide?
//
// The SDK's chest trace is in arbitrary units and its sign convention
// (does inhale go up or down?) is not something we rely on, so we
// compare shapes: resample both signals, normalise, and take the best
// absolute Pearson correlation over a small lag window. People follow a
// visual guide a little late, so lags of up to 2 seconds are allowed.

const RESAMPLE_HZ = 10;

function resample(samples, fromSec, toSec, hz = RESAMPLE_HZ) {
  const out = [];
  let j = 0;
  for (let t = fromSec; t <= toSec + 1e-9; t += 1 / hz) {
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    if (b.t === a.t) { out.push(a.v); continue; }
    const k = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    out.push(a.v + k * (b.v - a.v));
  }
  return out;
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx; const dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// samples: [{ t: seconds (same clock as guideStartSec), v: number }],
// sorted by t. Returns null when there is not enough signal yet.
function syncScore(samples, guideStartSec, opts = {}) {
  const pace = opts.pace || DEFAULT_PACE;
  const windowSec = opts.windowSec || 20;
  const minSpanSec = opts.minSpanSec || 10;
  const maxLagSec = opts.maxLagSec ?? 2;
  if (!samples || samples.length < 3) return null;

  const end = samples[samples.length - 1].t;
  const start = Math.max(samples[0].t, end - windowSec, guideStartSec);
  if (end - start < minSpanSec) return null;

  const inWindow = samples.filter((s) => s.t >= start - 1 && s.t <= end);
  const measured = resample(inWindow, start, end);

  // sign: +1 if the trace rises on inhale, -1 if it falls (lets the UI
  // draw the waveform the right way up).
  let best = { score: 0, lagSec: 0, sign: 1 };
  for (let lag = 0; lag <= maxLagSec + 1e-9; lag += 0.2) {
    const guide = measured.map((_, i) =>
      guideAt(start + i / RESAMPLE_HZ - lag - guideStartSec, pace).value);
    const r = pearson(measured, guide);
    if (Math.abs(r) > best.score) {
      best = { score: Math.abs(r), lagSec: Math.round(lag * 10) / 10, sign: r < 0 ? -1 : 1 };
    }
  }
  return best;
}

module.exports = { syncScore, pearson, resample };

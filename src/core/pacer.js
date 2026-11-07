'use strict';

// The breathing guide. A fixed in/out rhythm the user can follow.
// Default is 4s in, 6s out: 6 breaths per minute.

const DEFAULT_PACE = Object.freeze({ inhaleSec: 4, exhaleSec: 6 });

function cycleSec(pace = DEFAULT_PACE) {
  return pace.inhaleSec + pace.exhaleSec;
}

function breathsPerMinute(pace = DEFAULT_PACE) {
  return 60 / cycleSec(pace);
}

// Where in the cycle are we, `elapsedSec` after the guide started?
// value: -1 (empty lungs) .. +1 (full lungs), smooth at both turns.
function guideAt(elapsedSec, pace = DEFAULT_PACE) {
  const cycle = cycleSec(pace);
  const t = ((elapsedSec % cycle) + cycle) % cycle;
  if (t < pace.inhaleSec) {
    const progress = t / pace.inhaleSec;
    return { phase: 'in', progress, value: -Math.cos(Math.PI * progress) };
  }
  const progress = (t - pace.inhaleSec) / pace.exhaleSec;
  return { phase: 'out', progress, value: Math.cos(Math.PI * progress) };
}

module.exports = { DEFAULT_PACE, cycleSec, breathsPerMinute, guideAt };

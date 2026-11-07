'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Everything Exhale keeps on disk lives in one small JSON file plus an
// optional history file. No video, no images, no waveforms. Ever.
//
//   settings.json  { consentAt, keepHistory, telemetry }
//   history.jsonl  one session summary per line, only if keepHistory is on

function defaultDir() {
  if (process.env.EXHALE_DATA_DIR) return process.env.EXHALE_DATA_DIR;
  return path.join(os.homedir(), '.exhale');
}

class Settings {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.historyFile = path.join(dir, 'history.jsonl');
    this.data = { consentAt: null, keepHistory: false, telemetry: false, cameraId: null };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { /* first run */ }
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get hasConsent() { return !!this.data.consentAt; }

  grantConsent() { this.data.consentAt = new Date().toISOString(); this._save(); }
  revokeConsent() { this.data.consentAt = null; this._save(); }

  setCameraId(id) { this.data.cameraId = id || null; this._save(); }

  setKeepHistory(on) {
    this.data.keepHistory = !!on;
    this._save();
    if (!on) this.deleteHistory();
  }

  appendSummary(summary) {
    if (!this.data.keepHistory) return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.historyFile, JSON.stringify(summary) + '\n', { mode: 0o600 });
    return true;
  }

  readHistory() {
    try {
      return fs.readFileSync(this.historyFile, 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  deleteHistory() {
    try { fs.unlinkSync(this.historyFile); } catch { /* nothing to delete */ }
  }

  // "Delete everything": consent, preferences and history.
  deleteAll() {
    this.deleteHistory();
    try { fs.unlinkSync(this.file); } catch { /* nothing to delete */ }
    this.data = { consentAt: null, keepHistory: false, telemetry: false, cameraId: null };
  }

  public() {
    return { ...this.data, hasConsent: this.hasConsent, dataDir: this.dir };
  }
}

module.exports = { Settings };

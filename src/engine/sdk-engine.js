'use strict';

const { EventEmitter } = require('events');

// Wraps the Presage SmartSpectra Node SDK and turns its protobuf metrics
// into small plain frames the session understands:
//   { trace: [{t, v}], rate: [{t, value, stable, confidence}],
//     blinks: [{t, detected}], talking: [{t, detected}] }   (t in seconds)
//
// Only the four metrics Exhale actually uses are requested (data
// minimisation): chest breathing trace, breathing rate, blinking, talking.
// No face landmarks, no pulse, no expressions.

const REQUESTED = Object.freeze([
  0,  // CHEST_BREATHING  - the waveform drawn and scored against the guide
  2,  // BREATHING_RATE   - breaths per minute for the summary
  12, // BLINKING         - look-away reminders
  13, // TALKING          - pause the guide while you talk
]);

function tsToSec(ts) {
  if (ts == null) return 0;
  let n;
  if (typeof ts === 'number') n = ts;
  else if (typeof ts === 'bigint') n = Number(ts);
  else if (typeof ts.toNumber === 'function') n = ts.toNumber();
  else n = Number(ts);
  return n / 1e6;
}

function toFrame(m) {
  const b = m.breathing || {};
  const f = m.face || {};
  return {
    trace: (b.upperTrace || []).map((x) => ({ t: tsToSec(x.timestamp), v: x.value })),
    rate: (b.rate || []).map((x) => ({
      t: tsToSec(x.timestamp), value: x.value, stable: !!x.stable, confidence: x.confidence,
    })),
    blinks: (f.blinking || []).map((x) => ({ t: tsToSec(x.timestamp), detected: !!x.detected })),
    talking: (f.talking || []).map((x) => ({ t: tsToSec(x.timestamp), detected: !!x.detected })),
  };
}

const STATUS = ['uninitialized', 'idle', 'starting', 'running', 'stopping', 'error'];
const debug = (...a) => { if (process.env.EXHALE_DEBUG) console.log('[sdk]', ...a); };

class SdkEngine extends EventEmitter {
  // opts: { apiKey, source: 'camera' | 'file', file, cameraId, loop }
  constructor(opts) {
    super();
    if (!opts.apiKey) throw new Error('SMARTSPECTRA_API_KEY is not set');
    this.opts = opts;
    this.sdk = null;
    this.stopping = false;
  }

  _lib() {
    // Lazy: loading the native runtime is only needed for a real session.
    const lib = require('@smartspectra/node-sdk');
    const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
    return { ...lib, decodeMetrics };
  }

  async start() {
    debug('start() called, existing sdk:', !!this.sdk);
    if (this.sdk) return;
    const lib = this._lib();
    this.stopping = false;
    const sdk = new lib.SmartSpectraSDK({
      apiKey: this.opts.apiKey,
      requestedMetrics: [...REQUESTED],
      enableTelemetry: this.opts.telemetry === true,
      logLevel: lib.SmartSpectraLogLevel.kError,
    });
    this.sdk = sdk;

    // The SDK keeps ONE listener per event: a second sdk.on('metrics')
    // replaces the first. Keep everything metrics-related in this handler.
    let packets = 0;
    sdk.on('metrics', (buf) => {
      packets++;
      let m;
      try { m = lib.decodeMetrics(buf); } catch (e) {
        this.emit('error', { code: 'decode', message: e.message });
        return;
      }
      const frame = toFrame(m);
      if (process.env.EXHALE_DEBUG && (packets <= 2 || packets % 60 === 0)) {
        debug('packet', packets, 'trace', frame.trace.length, 'rate', frame.rate.length,
          'blinks', frame.blinks.length);
      }
      this.emit('frame', frame);
    });
    sdk.on('validationStatus', (code) => { debug('validation', code); this.emit('validation', code); });
    sdk.on('error', (code, message) => { debug('error event', code, message); this.emit('error', { code, message }); });
    sdk.on('processingStatus', (s) => {
      debug('status', STATUS[s]);
      this.emit('status', STATUS[s] || String(s));
      // Replays end at end-of-file; loop them so a demo keeps going.
      if (s === lib.ProcessingStatus.kIdle && this.opts.source === 'file'
          && this.opts.loop && !this.stopping && this.sdk === sdk) {
        setTimeout(() => { if (this.sdk === sdk && !this.stopping) sdk.start(); }, 250);
      }
    });

    if (this.opts.source === 'file') {
      // Play at real-time speed so the guide and the waveform line up.
      sdk.useFile(this.opts.file, { interframeDelayMs: 33 });
    } else {
      let cameras = null;
      try { cameras = lib.SmartSpectraSDK.availableCameras(); } catch { /* discovery unsupported */ }
      if (cameras && cameras.length === 0) {
        this.sdk = null;
        await sdk.destroy();
        const err = new Error('No camera found. Connect a webcam, open your laptop lid, or bring your iPhone close for Continuity Camera, then start another run.');
        err.code = 7;
        throw err;
      }
      const sel = this.opts.cameraId
        ? lib.CameraSelection.byId(this.opts.cameraId) : lib.CameraSelection.default;
      // Ask for 720p at 30 fps explicitly. Left to defaults, 4K webcams
      // (e.g. a Logitech BRIO) open in a high-res, low-frame-rate mode
      // and the SDK reports "frame rate too low".
      const capture = {};
      for (const [k, env, def] of [['width', 'EXHALE_CAMERA_WIDTH', 1280], ['height', 'EXHALE_CAMERA_HEIGHT', 720], ['fps', 'EXHALE_CAMERA_FPS', 30]]) {
        const v = Number(process.env[env] ?? def);
        if (v > 0) capture[k] = v;
      }
      debug('camera', sel, capture);
      sdk.useCamera(sel, capture);
    }
    debug('calling sdk.start()');
    sdk.start();
    debug('sdk.start() returned');
  }

  async stop() {
    debug('stop() called, has sdk:', !!this.sdk);
    const sdk = this.sdk;
    if (!sdk) return;
    this.stopping = true;
    this.sdk = null;
    try { await sdk.stopAsync(); } catch { /* not running */ }
    await sdk.destroy();
    this.emit('status', 'off');
  }
}

module.exports = { SdkEngine, toFrame, REQUESTED };

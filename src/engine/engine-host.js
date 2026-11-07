'use strict';

// Child process that owns the SmartSpectra SDK for exactly one run.
//
// Why a separate process: the SDK is native code with process-global
// state. A native crash (we have seen an OpenCV assertion when a webcam
// changed frame size mid-stream) would otherwise take the whole app down,
// and a new session started while the previous one is still tearing down
// is rejected. A fresh process per run avoids both.
//
// Protocol (process.send / 'message'):
//   parent → child: { cmd: 'start', opts } | { cmd: 'stop' } | { cmd: 'cameras' }
//   child → parent: { type: 'frame'|'status'|'validation'|'error'|'cameras'|'started'|'stopped', ... }

const { SdkEngine } = require('./sdk-engine');

let engine = null;
const send = (msg) => { if (process.connected) process.send(msg); };

process.on('message', async (msg) => {
  try {
    if (msg.cmd === 'cameras') {
      const { SmartSpectraSDK } = require('@smartspectra/node-sdk');
      let cameras = [];
      try { cameras = SmartSpectraSDK.availableCameras(); } catch { /* unsupported */ }
      send({ type: 'cameras', cameras: cameras.map((c) => ({ id: c.id, name: c.name })) });
      return;
    }
    if (msg.cmd === 'start' && msg.opts.source === 'selftest') {
      // Test hook: behave like a session that starts, sends a frame, then
      // dies the way a native crash would.
      send({ type: 'started' });
      send({ type: 'frame', data: { trace: [{ t: Date.now() / 1000, v: 1 }], rate: [], blinks: [], talking: [] } });
      setTimeout(() => process.abort(), Number(msg.opts.crashAfterMs || 200));
      return;
    }
    if (msg.cmd === 'start') {
      engine = new SdkEngine(msg.opts);
      for (const ev of ['frame', 'status', 'validation']) {
        engine.on(ev, (data) => send({ type: ev, data }));
      }
      engine.on('error', (e) => send({ type: 'error', data: { code: e.code, message: e.message } }));
      await engine.start();
      send({ type: 'started' });
      return;
    }
    if (msg.cmd === 'stop') {
      if (engine) await engine.stop();
      send({ type: 'stopped' });
      setImmediate(() => process.exit(0));
    }
  } catch (err) {
    send({ type: 'fatal', data: { code: err.code ?? 'start', message: err.message } });
    setImmediate(() => process.exit(1));
  }
});

process.on('disconnect', () => process.exit(0));

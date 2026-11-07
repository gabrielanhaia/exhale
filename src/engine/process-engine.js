'use strict';

const { EventEmitter } = require('events');
const { fork } = require('child_process');
const path = require('path');

// Same interface as SdkEngine, but the SDK runs in a child process
// (engine-host.js), a fresh one per run. See engine-host.js for why.

const HOST = path.join(__dirname, 'engine-host.js');
const STOP_TIMEOUT_MS = 8000;

function spawnHost() {
  const env = { ...process.env };
  // Inside Electron, run the child as plain Node with Electron's binary,
  // so macOS attributes camera access to the Exhale app.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return fork(HOST, [], { execPath: process.execPath, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
}

const friendly = (code, signal) =>
  `The camera pipeline stopped unexpectedly (${signal || `exit ${code}`}). Start another run to try again.`;

class ProcessEngine extends EventEmitter {
  // opts: SdkEngine options, plus getCameraId() to read the current choice.
  constructor(opts) {
    super();
    this.opts = opts;
    this.child = null;
    this.stopping = null; // promise while a previous run is shutting down
  }

  async start() {
    if (this.stopping) await this.stopping; // never overlap two native sessions
    if (this.child) return;
    const child = spawnHost();
    this.child = child;
    const cameraId = this.opts.getCameraId ? this.opts.getCameraId() : this.opts.cameraId;
    const { getCameraId, ...rest } = this.opts;

    await new Promise((resolve, reject) => {
      let settled = false;
      child.on('message', (msg) => {
        if (msg.type === 'started' && !settled) { settled = true; resolve(); return; }
        if (msg.type === 'fatal') {
          const err = Object.assign(new Error(msg.data.message), { code: msg.data.code });
          if (!settled) { settled = true; reject(err); } else this.emit('fatal', err);
          return;
        }
        if (['frame', 'status', 'validation', 'error'].includes(msg.type)) this.emit(msg.type, msg.data);
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        if (child.expectedExit) return;
        const err = Object.assign(new Error(friendly(code, signal)), { code: 'crash' });
        if (!settled) { settled = true; reject(err); } else this.emit('fatal', err);
      });
      child.send({ cmd: 'start', opts: { ...rest, cameraId: cameraId || null } });
    });
  }

  stop() {
    const child = this.child;
    if (!child) return this.stopping || Promise.resolve();
    this.child = null;
    child.expectedExit = true;
    this.stopping = new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, STOP_TIMEOUT_MS);
      child.once('exit', done);
      if (child.connected) child.send({ cmd: 'stop' });
      else child.kill('SIGKILL');
    }).finally(() => { this.stopping = null; this.emit('status', 'off'); });
    return this.stopping;
  }

  // List cameras in a short-lived child (discovery loads the native runtime).
  static listCameras() {
    return new Promise((resolve) => {
      const child = spawnHost();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve([]); }, 10_000);
      child.on('message', (msg) => {
        if (msg.type !== 'cameras') return;
        clearTimeout(timer);
        child.kill();
        resolve(msg.cameras);
      });
      child.on('exit', () => { clearTimeout(timer); resolve([]); });
      child.send({ cmd: 'cameras' });
    });
  }
}

module.exports = { ProcessEngine };

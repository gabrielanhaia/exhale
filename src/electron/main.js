'use strict';

// Desktop shell: a normal app (dock icon, Cmd+Q, an Exhale window) plus a
// small always-on-top card in the corner of the screen that appears only
// during agent runs. The engine, session and UI are the same ones the
// Docker / browser mode uses; Electron only adds windows, tray and dock.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, screen, systemPreferences, shell,
} = require('electron');
const { startApp } = require('../app');

const CARD_W = 340;
const CARD_H = 470;

let core = null;
let overlay = null;
let mainWin = null;
let tray = null;
let quitting = false;

function placeOverlay(win) {
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: workArea.x + workArea.width - CARD_W - 16,
    y: workArea.y + workArea.height - CARD_H - 16,
    width: CARD_W,
    height: CARD_H,
  });
}

function lockDown(win) {
  // Only our own local page. No popups, no navigation away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(core.url)) e.preventDefault();
  });
}

const SAFE = { contextIsolation: true, sandbox: true, nodeIntegration: false };

function createOverlay() {
  overlay = new BrowserWindow({
    width: CARD_W,
    height: CARD_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: SAFE,
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeOverlay(overlay);
  lockDown(overlay);
  overlay.loadURL(`${core.url}/?view=overlay`);
}

function openWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 420,
    title: 'Exhale',
    backgroundColor: '#0f1226',
    webPreferences: SAFE,
  });
  lockDown(mainWin);
  mainWin.loadURL(core.url);
}

function quit() {
  quitting = true;
  app.quit();
}

function updateTray(snap) {
  if (!tray) return;
  tray.setTitle(snap.cameraOn ? ' ● exhale' : ' exhale');
  tray.setToolTip(snap.cameraOn ? 'Exhale: camera on' : 'Exhale: camera off');
}

function onChange() {
  const snap = core.session.snapshot();
  updateTray(snap);
  if (!overlay || overlay.isDestroyed()) return;
  if (snap.mode === 'idle') overlay.hide();
  else if (!overlay.isVisible()) overlay.showInactive(); // never steal focus from your terminal
}

// On macOS, ask for camera access the first time it is needed, so the
// system prompt appears.
function wrapEngineForPermissions(engine) {
  const start = engine.start.bind(engine);
  engine.start = async () => {
    if (process.platform === 'darwin' && core.cfg.source === 'camera') {
      const status = systemPreferences.getMediaAccessStatus('camera');
      const ok = status === 'granted' || await systemPreferences.askForMediaAccess('camera');
      if (!ok) {
        const err = new Error(status === 'denied'
          ? 'macOS is blocking the camera. Allow Exhale (Electron) in System Settings, Privacy & Security, Camera, then start another run.'
          : 'macOS did not show the camera prompt. Start Exhale with `npm run app` so it runs as its own app.');
        err.code = 'permission';
        throw err;
      }
    }
    return start();
  };
}

app.setName('Exhale');

app.whenReady().then(async () => {
  core = await startApp({ shell: { openWindow, quit } });
  wrapEngineForPermissions(core.engine);

  tray = new Tray(nativeImage.createEmpty());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Exhale', click: openWindow },
    { label: 'Hide the card (camera off)', click: () => core.session.dismiss() },
    { type: 'separator' },
    { label: 'Quit Exhale', click: quit },
  ]));

  createOverlay();
  core.session.on('change', onChange);
  onChange();
  if (!process.env.EXHALE_NO_WINDOW) openWindow();
  console.log(`exhale: ${core.cfg.source} source, UI at ${core.url}`);
});

// Closing the Exhale window keeps the app (and the agent hooks) alive;
// the dock icon, the menu-bar item or Cmd+Q bring it back or quit it.
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('activate', openWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (e) => {
  if (!core) return;
  e.preventDefault();
  const c = core; core = null;
  await c.close().catch(() => {});
  app.exit(0);
});

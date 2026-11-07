'use strict';

// Drives the real Electron app (simulated sensor) the way a person would,
// and screenshots every state for review.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../src/app');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'test-results', 'screens');

async function launch(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhale-e2e-'));
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      EXHALE_SOURCE: 'fake',
      EXHALE_PORT: '0',
      EXHALE_GRACE_MS: '3000',
      EXHALE_SUMMARY_MS: '60000',
      EXHALE_DATA_DIR: dataDir,
      EXHALE_FAKE_WARMUP_SEC: '12',
      ...extraEnv,
    },
  });
  const byUrl = async (pred) => {
    let found = null;
    await expect.poll(() => {
      found = app.windows().find((w) => pred(w.url())) || null;
      return !!found;
    }).toBe(true);
    await found.waitForLoadState('domcontentloaded');
    return found;
  };
  const overlay = await byUrl((u) => u.includes('view=overlay'));
  const main = extraEnv.EXHALE_NO_WINDOW ? null
    : await byUrl((u) => u.startsWith('http') && !u.includes('view=overlay'));
  const base = new URL(overlay.url()).origin;
  const api = (p, body, method = 'POST') => overlay.evaluate(
    ([u, b, m]) => fetch(u, {
      method: m,
      headers: m === 'GET' ? {} : { 'content-type': 'application/json', 'x-exhale': '1' },
      body: b ? JSON.stringify(b) : undefined,
    }).then((r) => r.json()),
    [base + p, body, method],
  );
  const overlayVisible = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('view=overlay')).isVisible());
  return { app, overlay, main, api, overlayVisible, dataDir };
}

// Resize the real window (not an emulated viewport), like a person would.
async function resize(app, page, width, height) {
  const url = page.url();
  await app.evaluate(({ BrowserWindow }, [u, w, h]) => {
    BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === u).setContentSize(w, h);
  }, [url, width, height]);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));

test('first run: "Try it now" walks through consent, the guide and the recap', async () => {
  const { app, overlay, main, overlayVisible } = await launch();
  try {
    await resize(app, main, 1300, 760);
    await expect(main.locator('h1')).toHaveText('Breathe while your agent works.');
    await expect(main.locator('#status-line')).toHaveText('Watching for agent runs');
    await expect(main.locator('#card')).toBeHidden(); // desktop: the card lives in the corner
    expect(await overlayVisible()).toBe(false);
    await shot(main, 'w1-idle-wide');

    await main.getByRole('button', { name: 'Try it now' }).click();
    await expect(main.locator('#try-note')).toContainText('bottom-right corner of your screen');
    await expect(main.getByRole('button', { name: 'End test run' })).toBeVisible();
    await expect.poll(overlayVisible).toBe(true);
    await expect(overlay.locator('[data-view="pending"]')).toBeVisible();
    await expect(overlay.locator('#grace')).toHaveText(/^[0-3]$/);
    await shot(overlay, 'c1-pending');

    await expect(overlay.locator('[data-view="consent"]')).toBeVisible({ timeout: 6000 });
    await expect(main.locator('#try-note')).toContainText('Allow the camera');
    await shot(overlay, 'c2-consent');
    await shot(main, 'w2-waiting-consent');

    await overlay.getByRole('button', { name: 'Turn on camera' }).click();
    await expect(overlay.locator('[data-view="active"]')).toBeVisible();
    await expect(overlay.locator('#cam')).toHaveText('camera on');
    await expect(main.locator('#status-line')).toHaveText('Guiding, camera on');
    await expect(overlay.locator('#phase')).toHaveText(/^(in|out)$/);
    await overlay.waitForTimeout(800);
    await shot(overlay, 'c3-active-start');

    await expect(overlay.locator('#rate-line')).toHaveText(/breaths a minute/, { timeout: 30_000 });
    await expect(overlay.locator('#sync-line')).toHaveText(/\d+%/, { timeout: 30_000 });
    await overlay.waitForTimeout(2500);
    await shot(overlay, 'c4-active-reading');
    await shot(main, 'w3-guiding');

    await main.getByRole('button', { name: 'End test run' }).click();
    await expect(overlay.locator('[data-view="summary"]')).toBeVisible();
    await expect(overlay.locator('#cam')).toHaveText('camera off');
    await expect(overlay.locator('#sum-title')).toHaveText('Test run finished.');
    await expect(overlay.locator('#sum-stats')).toContainText('Agent ran for');
    await expect(main.getByRole('button', { name: 'Try it now' })).toBeEnabled();
    await overlay.waitForTimeout(800);
    await shot(overlay, 'c5-summary');

    await overlay.getByRole('button', { name: 'Close' }).click();
    await expect.poll(overlayVisible).toBe(false);
  } finally {
    await app.close();
  }
});

test('every card state has a way out', async () => {
  const { app, overlay, api, overlayVisible } = await launch({ EXHALE_NO_WINDOW: '1' });
  try {
    // pending → Skip → camera-off card → Close → hidden
    await api('/api/agent/start', { id: 'a' });
    await overlay.getByRole('button', { name: 'Skip this run' }).click();
    await expect(overlay.locator('[data-view="snoozed"]')).toBeVisible();
    await shot(overlay, 'c6-snoozed');
    await overlay.getByRole('button', { name: 'Close' }).click();
    await expect.poll(overlayVisible).toBe(false);
    await api('/api/agent/stop', { id: 'a' });

    // active → × in the header → camera off → Close → hidden
    await api('/api/consent', { granted: true });
    await api('/api/agent/start', { id: 'b' });
    await expect(overlay.locator('[data-view="active"]')).toBeVisible({ timeout: 6000 });
    await overlay.getByRole('button', { name: 'Hide this card and turn the camera off' }).click();
    await expect(overlay.locator('[data-view="snoozed"]')).toBeVisible();
    expect((await api('/api/state', null, 'GET')).cameraOn).toBe(false);
    await overlay.getByRole('button', { name: 'Close' }).click();
    await expect.poll(overlayVisible).toBe(false);
    await api('/api/agent/stop', { id: 'b' });

    // ≡ opens the Exhale window
    await api('/api/agent/start', { id: 'c' });
    await expect.poll(overlayVisible).toBe(true);
    const before = app.windows().length;
    await overlay.getByRole('button', { name: 'Open the Exhale window' }).click();
    await expect.poll(() => app.windows().length).toBe(before + 1);
  } finally {
    await app.close();
  }
});

test('Claude Code: copy hooks, then hook events show as connected', async () => {
  const { app, main, api } = await launch();
  try {
    await main.getByRole('button', { name: 'Copy Claude Code hooks' }).click();
    await expect(main.locator('#copy-hooks')).toHaveText(/Copied/);
    const parsed = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()));
    expect(Object.keys(parsed.hooks)).toEqual(['UserPromptSubmit', 'Stop', 'SessionEnd']);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('/api/hook');

    await api('/api/hook', { session_id: 's1', hook_event_name: 'UserPromptSubmit' });
    await expect(main.locator('#hook-status')).toHaveText(/Connected/);
    await expect(main.locator('#status-line')).toHaveText(/Agent running/);
    await api('/api/hook', { session_id: 's1', hook_event_name: 'Stop' });
    await expect(main.locator('#status-line')).toHaveText('Watching for agent runs');
  } finally {
    await app.close();
  }
});

test('privacy: history is opt-in and "Delete all" wipes it', async () => {
  const { app, main, api, dataDir } = await launch({ EXHALE_SUMMARY_MS: '500' });
  try {
    await expect(main.locator('#history')).toContainText('History is off');
    await main.locator('#keep-history').check();
    await api('/api/consent', { granted: true });
    await api('/api/agent/start', { id: 'h' });
    await expect(main.locator('#status-line')).toHaveText('Guiding, camera on', { timeout: 6000 });
    await api('/api/agent/stop', { id: 'h' });
    await expect(main.locator('#history li')).toHaveCount(1);
    expect(fs.existsSync(path.join(dataDir, 'history.jsonl'))).toBe(true);
    await main.getByRole('button', { name: 'Delete all Exhale data' }).click();
    await expect.poll(() => fs.existsSync(path.join(dataDir, 'history.jsonl'))).toBe(false);
    await expect(main.locator('#consent-state')).toContainText('not allowed the camera yet');
  } finally {
    await app.close();
  }
});

test('window layout holds at wide, medium and narrow sizes', async () => {
  const { app, main } = await launch();
  try {
    for (const [w, h] of [[1300, 760], [860, 720], [480, 800]]) {
      await resize(app, main, w, h);
      const overflow = await main.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `no horizontal scroll at ${w}px`).toBeLessThanOrEqual(0);
      const topbar = await main.locator('.topbar').boundingBox();
      const hero = await main.locator('.hero-text').boundingBox();
      const block = await main.locator('.block').first().boundingBox();
      expect(Math.abs(topbar.x - hero.x), `hero aligned at ${w}px`).toBeLessThan(2);
      expect(Math.abs(topbar.x - block.x), `sections aligned at ${w}px`).toBeLessThan(2);
      await shot(main, `w-layout-${w}`);
    }
  } finally {
    await app.close();
  }
});

test('Quit Exhale closes the app', async () => {
  const { app, main } = await launch();
  const closed = new Promise((r) => app.process().on('exit', r));
  await main.getByRole('button', { name: 'Quit Exhale' }).click();
  await closed;
});

test('browser / Docker mode: the card sits in the page', async () => {
  const server = await startApp({
    source: 'fake', port: 0, graceMs: 1500,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'exhale-b-')),
  });
  const { app } = await launch({ EXHALE_NO_WINDOW: '1' });
  try {
    await app.evaluate(({ BrowserWindow }, url) => {
      new BrowserWindow({ width: 1100, height: 800 }).loadURL(url);
    }, server.url);
    let page = null;
    await expect.poll(() => {
      page = app.windows().find((w) => w.url().startsWith(server.url)) || null;
      return !!page;
    }).toBe(true);
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Quit Exhale' })).toBeHidden();
    await page.getByRole('button', { name: 'Try it now' }).click();
    await expect(page.locator('#try-note')).toContainText('on the card');
    await page.getByRole('button', { name: 'Turn on camera' }).click({ timeout: 5000 });
    await expect(page.locator('[data-view="active"]')).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, 'b1-browser-guiding');
    await page.setViewportSize({ width: 420, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'b2-browser-phone');
  } finally {
    await app.close();
    await server.close();
  }
});

test('camera source: the Camera section lists real cameras and saves the choice', async () => {
  // Discovery only: no session starts, no credits are used.
  const { app, main, dataDir } = await launch({ EXHALE_SOURCE: 'camera' });
  try {
    await expect(main.locator('#camera-block')).toBeVisible();
    await expect.poll(() => main.locator('#camera-select option').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const options = await main.locator('#camera-select option').allTextContents();
    expect(options[0]).toBe('System default');
    await main.locator('#camera-block').scrollIntoViewIfNeeded();
    await shot(main, 'w4-camera-section');
    if (options.length > 1) {
      const value = await main.locator('#camera-select option').nth(1).getAttribute('value');
      await main.locator('#camera-select').selectOption(value);
      await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).cameraId)
        .toBe(value);
    }
  } finally {
    await app.close();
  }
});

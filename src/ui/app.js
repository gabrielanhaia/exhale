'use strict';

// Exhale UI. Renders whatever the local server streams over SSE.
// ?view=overlay is the Electron corner card; without it, the full page
// (browser, Docker, settings window).
//
// The scene: a sky at dusk. The guide is a sun that rises while you
// breathe in and sets while you breathe out. The horizon is your own
// breathing waveform from the camera, so the sun sets onto your breath.

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'overlay') document.body.classList.add('overlay');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  let state = null;
  let lastRender = '';
  let guideDeadline = null;
  const TRY_MS = 90_000;

  function hooksJson() {
    // Skip unattended runs (claude -p, scheduled jobs): no camera without a person there.
    const cmd = `[ "$CLAUDE_CODE_SESSION_ATTENDED" = "0" ] && exit 0; curl -s -m 1 -X POST -H 'X-Exhale: 1' -H 'Content-Type: application/json' `
      + `--data-binary @- ${location.origin}/api/hook >/dev/null 2>&1 || true`;
    const hook = [{ hooks: [{ type: 'command', command: cmd }] }];
    return JSON.stringify({ hooks: { UserPromptSubmit: hook, Stop: hook, SessionEnd: hook } }, null, 2);
  }

  async function copyHooks(btn) {
    try {
      await navigator.clipboard.writeText(hooksJson());
      btn.textContent = 'Copied. Paste into ~/.claude/settings.json';
    } catch {
      btn.textContent = 'Copy failed. Run: exhale hooks';
    }
    setTimeout(() => { btn.textContent = 'Copy Claude Code hooks'; }, 4000);
  }

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  // Same curve as src/core/pacer.js, so the sun and the scoring agree.
  function guideAt(sec, pace) {
    const cycle = pace.inhaleSec + pace.exhaleSec;
    const t = ((sec % cycle) + cycle) % cycle;
    if (t < pace.inhaleSec) {
      const p = t / pace.inhaleSec;
      return { phase: 'in', left: pace.inhaleSec - t, value: -Math.cos(Math.PI * p) };
    }
    const p = (t - pace.inhaleSec) / pace.exhaleSec;
    return { phase: 'out', left: cycle - t, value: Math.cos(Math.PI * p) };
  }

  async function post(path, body, method = 'POST') {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-exhale': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  // ---- actions -----------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'dismiss') await post('/api/dismiss');
    if (a === 'consent') await post('/api/consent', { granted: true });
    if (a === 'revoke') await post('/api/consent', { granted: false });
    if (a === 'try') await post('/api/agent/start', { id: 'try', label: 'Test run', maxMs: TRY_MS });
    if (a === 'end-try') await post('/api/agent/stop', { id: 'try' });
    if (a === 'copy-hooks') copyHooks(btn);
    if (a === 'refresh-cameras') loadCameras(btn);
    if (a === 'open-window') await post('/api/shell', { action: 'openWindow' });
    if (a === 'quit') await post('/api/shell', { action: 'quit' });
    if (a === 'delete-all') { await post('/api/data', null, 'DELETE'); loadHistory(); }
  });
  $('camera-select').addEventListener('change', async (e) => {
    await post('/api/settings', { cameraId: e.target.value || null });
  });

  let camerasLoaded = false;
  async function loadCameras(btn) {
    if (btn) btn.textContent = 'Looking…';
    const list = await (await fetch('/api/cameras')).json();
    const sel = $('camera-select');
    const current = state && state.settings.cameraId;
    sel.textContent = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'System default';
    sel.appendChild(def);
    for (const c of list) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name || c.id;
      sel.appendChild(o);
    }
    if (current && !list.some((c) => c.id === current)) {
      const o = document.createElement('option');
      o.value = current; o.textContent = 'Saved camera (not connected)';
      sel.appendChild(o);
    }
    sel.value = current || '';
    if (btn) btn.textContent = 'Refresh list';
  }

  $('keep-history').addEventListener('change', async (e) => {
    await post('/api/settings', { keepHistory: e.target.checked });
    loadHistory();
  });

  async function loadHistory() {
    const list = await (await fetch('/api/history')).json();
    const ol = $('history');
    ol.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = state && state.settings.keepHistory
        ? 'No runs yet.' : 'History is off, so nothing is stored.';
      ol.appendChild(li);
      return;
    }
    for (const s of list.slice(-10).reverse()) {
      const li = document.createElement('li');
      const when = new Date(s.endedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      li.textContent = `${when}: ${fmtDur(s.agentSec)} run`
        + (s.syncPct != null ? `, ${s.syncPct}% with the guide` : '');
      ol.appendChild(li);
    }
  }

  // ---- text --------------------------------------------------------------
  function fmtDur(sec) {
    if (sec == null) return 'unknown';
    const m = Math.floor(sec / 60); const s = sec % 60;
    if (!m) return `${s}s`;
    return s ? `${m} min ${s}s` : `${m} min`;
  }

  function render(s) {
    document.querySelectorAll('.view').forEach((v) => {
      v.classList.toggle('on', v.dataset.view === s.mode);
    });
    $('cam').dataset.on = String(s.cameraOn);
    $('cam').textContent = s.cameraOn ? 'camera on' : 'camera off';
    $('agent-label').textContent = s.label || 'Your agent';
    const graceSec = String(Math.round((s.meta.graceMs || 0) / 1000));
    document.querySelectorAll('.grace-sec').forEach((el) => { el.textContent = graceSec; });
    guideDeadline = s.mode === 'pending' && s.guideInMs != null ? Date.now() + s.guideInMs : null;
    renderPage(s);
    $('sim').hidden = !(s.meta && s.meta.source === 'fake');
    document.body.classList.toggle('desktop', !!s.meta.desktop);

    const err = $('error');
    err.hidden = !s.error;
    if (s.error) err.textContent = s.error.message;

    if (s.mode === 'active') {
      $('hint').hidden = !s.hint;
      if (s.hint) $('hint').textContent = s.hint;
      $('nudge').hidden = !s.lookAway;
      const sync = $('sync-line');
      if (s.sync == null) {
        sync.textContent = 'Breathe in as the sun rises, out as it sets.';
        sync.classList.remove('in-sync');
      } else {
        sync.textContent = s.sync >= 60 ? `With the guide, ${s.sync}%` : `Follow the sun, ${s.sync}% so far`;
        sync.classList.toggle('in-sync', s.sync >= 60);
      }
      $('rate-line').textContent = s.breathingRate == null
        ? (s.trace.length ? 'The line is your breathing.' : 'Reading your breathing…')
        : `${s.breathingRate} breaths a minute`;
    }

    if (s.mode === 'summary' && s.summary) renderSummary(s.summary);

    const st = s.settings;
    $('keep-history').checked = !!st.keepHistory;
    $('consent-state').textContent = st.hasConsent
      ? `You allowed the camera on ${new Date(st.consentAt).toLocaleDateString([], { dateStyle: 'medium' })}. It still only turns on during long agent runs.`
      : 'You have not allowed the camera yet. Exhale asks the first time a long run starts.';
  }

  function renderPage(s) {
    const desktop = !!s.meta.desktop;
    const status = {
      idle: ['Watching for agent runs', 'idle'],
      pending: ['Agent running, guide about to start', 'wait'],
      consent: ['Waiting for camera permission', 'wait'],
      active: ['Guiding, camera on', 'live'],
      snoozed: ['Camera off for this run', 'idle'],
      summary: ['Run finished', 'idle'],
    }[s.mode] || ['', 'idle'];
    $('status-line').textContent = status[0];
    $('status-pill').dataset.tone = status[1];

    $('try-btn').disabled = s.mode !== 'idle' && s.mode !== 'summary';
    $('try-btn').hidden = s.testRun;
    $('end-try-btn').hidden = !s.testRun;
    const where = desktop ? 'in the bottom-right corner of your screen' : 'on the card';
    const note = s.testRun ? {
      pending: `Look ${where}. The guide starts in a few seconds.`,
      consent: `Allow the camera ${where} to start.`,
      active: `Breathe with the sun ${where}. The test run ends by itself after 90 seconds.`,
      snoozed: 'Camera off. End the test run when you are ready.',
    }[s.mode] : (s.mode === 'summary' ? 'Done. The camera is off, and the recap is on the card.' : null);
    $('try-note').hidden = !note;
    if (note) $('try-note').textContent = note;

    const camBlock = $('camera-block');
    camBlock.hidden = s.meta.source !== 'camera';
    if (!camBlock.hidden && !camerasLoaded) { camerasLoaded = true; loadCameras(); }

    $('hook-status').textContent = s.lastHookAt
      ? `Connected. Last event from Claude Code ${ago(s.lastHookAt)}.` : '';
  }

  function renderSummary(sum) {
    $('sum-title').textContent = `${sum.label || 'Your agent'} finished.`;
    const rows = [['Agent ran for', fmtDur(sum.agentSec)]];
    if (sum.syncPct != null) {
      rows.push(sum.inSyncSec > 0
        ? ['You breathed with the guide for', `${fmtDur(sum.inSyncSec)}, ${sum.syncPct}% of the time`]
        : ['With the guide', 'Not this time. Try following the sun next run.']);
    }
    if (sum.breathingStart != null) {
      rows.push(sum.breathingEnd < sum.breathingStart
        ? ['Your breathing slowed', `from ${sum.breathingStart} to ${sum.breathingEnd} a minute`]
        : ['Your breathing', `${sum.breathingStart} to ${sum.breathingEnd} a minute`]);
    }
    if (sum.lookAwayNudges) rows.push(['Look-away breaks', String(sum.lookAwayNudges)]);
    const dl = $('sum-stats');
    dl.textContent = '';
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.appendChild(div);
    }
  }

  // ---- the sky -----------------------------------------------------------
  const sky = $('sky');
  const ctx = sky.getContext('2d');
  const word = $('phase');
  const breath = $('breath');

  const NIGHT = [22, 26, 51];
  const BLUE_HOUR = [58, 82, 140];
  const DUSK_LOW = [44, 42, 92];
  const DAWN_LOW = [196, 150, 168];
  const GROUND = [13, 16, 36];
  const SUN = [255, 207, 122];
  const STARS = Array.from({ length: 26 }, (_, i) => ({
    x: ((i * 9301 + 49297) % 233280) / 233280,
    y: ((i * 4093 + 1777) % 1000) / 1000,
    r: 0.5 + ((i * 7) % 5) / 6,
  }));

  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // Light level (0 = dusk, 1 = full inhale) and horizon height, eased
  // between modes so the scene never jumps.
  let light = 0;
  let horizon = 0.86;

  function sizeCanvas() {
    const r = sky.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr); const h = Math.round(r.height * dpr);
    if (sky.width !== w || sky.height !== h) { sky.width = w; sky.height = h; }
    return { W: r.width, H: r.height, dpr };
  }

  function targets(now) {
    const mode = state ? state.mode : 'idle';
    if (mode === 'active' && state.guideStartMs) {
      const g = guideAt((now - state.guideStartMs) / 1000, state.pace);
      return { light: (g.value + 1) / 2, horizon: 0.56, g };
    }
    if (mode === 'summary') return { light: 0.04, horizon: 0.9 };
    if (mode === 'pending') return { light: 0.12, horizon: 0.86 };
    return { light: 0, horizon: 0.86 };
  }

  function horizonPoints(W, H, y0, now) {
    // The live waveform, the last 20 seconds across the full width.
    const pts = state && state.mode === 'active' ? state.trace : [];
    const span = 20; const end = now / 1000; const start = end - span;
    const vis = pts.filter((p) => p[0] >= start);
    // Wait for a few seconds of signal; a sliver normalised to full
    // height draws a spike.
    if (vis.length < 2 || vis[vis.length - 1][0] - vis[0][0] < 5) return null;
    let lo = Infinity; let hi = -Infinity;
    for (const p of vis) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const mid = (lo + hi) / 2; const half = Math.max((hi - lo) / 2, 1e-6);
    const amp = H * 0.045; const sign = state.traceSign || 1;
    return vis.map((p) => [((p[0] - start) / span) * W, y0 - sign * ((p[1] - mid) / half) * amp]);
  }

  function draw(now) {
    const { W, H, dpr } = sizeCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = targets(now);
    const active = state && state.mode === 'active';
    light = active ? t.light : light + (t.light - light) * 0.12;
    horizon += (t.horizon - horizon) * 0.18;
    const paused = active && state.talking;
    const k = paused ? light * 0.5 : light;
    const y0 = H * horizon;

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, y0 + H * 0.06);
    g.addColorStop(0, rgb(mix(NIGHT, BLUE_HOUR, k * 0.9)));
    g.addColorStop(1, rgb(mix(DUSK_LOW, DAWN_LOW, k * 0.75)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars fade out as the light comes up
    const starAlpha = (1 - k) * 0.7;
    if (starAlpha > 0.02) {
      ctx.fillStyle = rgb([233, 236, 247], starAlpha);
      for (const s of STARS) {
        if (s.y * H > y0 * 0.8) continue;
        ctx.beginPath(); ctx.arc(s.x * W, s.y * H * 0.8, s.r, 0, Math.PI * 2); ctx.fill();
      }
    }

    // the sun: rises on the in-breath, sets on the out-breath
    const showSun = state && ['active', 'summary', 'pending'].includes(state.mode);
    if (showSun) {
      const sunR = Math.min(W, H) * 0.095;
      const top = H * 0.2;
      const sy = (y0 + sunR * 0.55) - k * ((y0 + sunR * 0.55) - top);
      const sx = W * 0.5;
      const inSync = active && state.sync != null && state.sync >= 60;
      const glowR = sunR * (inSync ? 5 : 3.6);
      const glow = ctx.createRadialGradient(sx, sy, sunR * 0.6, sx, sy, glowR);
      glow.addColorStop(0, rgb(SUN, 0.45 * (0.5 + k / 2)));
      glow.addColorStop(1, rgb(SUN, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.beginPath(); ctx.arc(sx, sy, sunR, 0, Math.PI * 2);
      ctx.fillStyle = rgb(paused ? [200, 190, 170] : SUN);
      ctx.fill();
    }

    // the ground, cut by your breath
    const pts = horizonPoints(W, H, y0, now);
    ctx.beginPath();
    if (pts) {
      ctx.moveTo(0, pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(W, pts[pts.length - 1][1]);
    } else {
      ctx.moveTo(0, y0); ctx.lineTo(W, y0);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const gr = ctx.createLinearGradient(0, y0, 0, H);
    gr.addColorStop(0, rgb(mix(GROUND, [30, 34, 70], k * 0.6)));
    gr.addColorStop(1, rgb(GROUND));
    ctx.fillStyle = gr;
    ctx.fill();

    // rim light along the horizon line
    if (pts) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = rgb(SUN, 0.35 + 0.5 * k);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // the phase word swells on the in-breath, narrows on the out-breath
    if (active && t.g) {
      breath.classList.toggle('paused', paused);
      word.textContent = paused ? 'paused while you talk' : t.g.phase;
      $('count').textContent = paused ? '' : String(Math.ceil(t.g.left));
      if (!paused && !reduceMotion) {
        word.style.fontStretch = `${75 + 25 * k}%`;
        word.style.fontWeight = String(Math.round(250 + 350 * k));
      } else {
        word.style.fontStretch = '';
        word.style.fontWeight = '';
      }
    }
  }

  function frame() {
    if (guideDeadline) {
      $('grace').textContent = String(Math.max(0, Math.ceil((guideDeadline - Date.now()) / 1000)));
    }
    try { draw(Date.now()); } catch (e) { console.error(e); }
    requestAnimationFrame(frame);
  }

  // ---- data --------------------------------------------------------------
  function connect() {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const prevMode = state && state.mode;
      state = JSON.parse(ev.data);
      const key = JSON.stringify({ ...state, trace: null, guideStartMs: null, traceSign: null });
      if (key !== lastRender) { render(state); lastRender = key; }
      if (prevMode !== state.mode && state.mode === 'summary') loadHistory();
      document.body.dataset.mode = state.mode;
    };
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  }

  connect();
  loadHistory();
  requestAnimationFrame(frame);
})();

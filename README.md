# Exhale

A breathing guide that shows up while your AI coding agent works.

When Claude Code (or any long command) runs for more than a few seconds, a small card rises in the corner of your screen. A sun climbs as you breathe in and sinks as you breathe out. The horizon it sinks behind is **your own breathing**, read live from your webcam by the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra). When the agent finishes, the camera turns off and you get a one-line recap: how long the agent ran, how long you breathed with the guide, and whether your breathing slowed.

If you go a while without blinking, it suggests looking at something far away for 20 seconds. If you start talking, the guide pauses.

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).

## What it uses from the SDK

Exhale requests four metrics and nothing else:

| Metric | Used for |
|---|---|
| `CHEST_BREATHING` (waveform) | the horizon line, and scoring how closely you follow the guide |
| `BREATHING_RATE` | breaths per minute in the recap |
| `BLINKING` | look-away reminders |
| `TALKING` | pausing the guide while you talk |

No face landmarks, no pulse, no expressions.

"With the guide" is the best correlation between your chest waveform and the guide curve over the last 20 seconds, allowing up to 2 seconds of lag, since people follow a visual cue a little late (`src/core/sync.js`).

## Run it

You need Node 20+ and a SmartSpectra API key from [physiology.presagetech.com](https://physiology.presagetech.com). Put the key in `.env`:

```bash
echo "SMARTSPECTRA_API_KEY=your_key" > .env
npm install
```

### Desktop app (live camera, macOS Apple Silicon / Windows x64 / Linux)

```bash
npm run app     # macOS: launches Exhale as its own app, so macOS can ask for the camera
npm start       # Windows / Linux
```

The Exhale window opens. Click **Try it now** for a 90-second test session: a card appears in the bottom-right corner of your screen, asks before using the camera, then guides you. Close the window and Exhale keeps running in the menu bar and the dock, ready for your agent. Quit from the window, the dock, the menu bar, or Cmd+Q.

On macOS, start it with `npm run app`, not `npm start` from a terminal: a process started inside a terminal cannot show the camera permission prompt.

Pick your camera in the window's **Camera** section. An iPhone works well through Continuity Camera (same Apple ID, Wi-Fi and Bluetooth on, iPhone held landscape with the back cameras facing you). The SDK needs about 30 frames a second: many webcams drop below that in a dim room, and Exhale tells you when that happens.

### No camera, no key: demo mode

```bash
npm run demo        # browser UI at http://127.0.0.1:7777, simulated sensor
npm run demo:app    # same, in the desktop overlay
```

The simulated sensor is labelled as simulated on screen. It never pretends to be a measurement.

### Docker

```bash
docker compose --profile demo up demo        # simulated sensor, no key needed
docker compose --profile replay up replay    # a clip in ./test-assets through the real SDK
docker compose --profile camera up camera    # live webcam (Linux hosts only)
```

Then open http://localhost:7777. The port is bound to `127.0.0.1`, so other machines on your network can't reach it.

Docker Desktop on macOS and Windows can't pass a webcam into a container. On those hosts, use `demo`, `replay`, or the desktop app.

## Connect your agent

**Claude Code.** In the Exhale window, click **Copy Claude Code hooks** (or run `node bin/exhale.js hooks`) and merge the result into `~/.claude/settings.json`. The window shows "Connected" once the first hook arrives. It adds `UserPromptSubmit`, `Stop` and `SessionEnd` hooks that POST to Exhale. If Exhale is not running, the hook fails silently in under a second and Claude Code carries on.

**Anything else.** Wrap the command:

```bash
node bin/exhale.js run -- npm test
node bin/exhale.js run -- codex exec "fix the failing test"
```

The command's output, input and exit code pass through untouched.

Runs shorter than 10 seconds never turn the camera on (`EXHALE_GRACE_MS`).

## Consent and data handling

**Consent.** The first time a long run starts, the card asks before the camera is used, and says what will happen. Until you say yes, the camera stays off. You can withdraw consent at any time from the settings page (tray menu, then Open Exhale), which turns the camera off immediately. On macOS the system camera prompt also appears once.

**When the camera is on.** Only while an agent run is in progress and the card is showing. The card header says "camera on", and the menu-bar item shows a dot. "Turn off camera" stops it at once for the rest of that run. When the run ends, the camera is released.

**Where video goes.** Frames go straight from the camera into the SmartSpectra SDK inside the Exhale process, which computes the metrics on your computer. Exhale never writes video or images to disk and never sends them anywhere.

**What leaves your computer.** The SDK contacts Presage's servers to authenticate the API key, meter usage, and download its models. Presage's [telemetry documentation](https://github.com/Presage-Security/SmartSpectra/blob/main/docs/telemetry-and-privacy.md) describes an optional aggregate telemetry summary (no frames, no measured values, no identifiers). **Exhale turns that telemetry off** (`enableTelemetry: false`). Exhale itself has no analytics and makes no other network calls. It does not use the SDK's optional LLM Insights feature.

**What is stored.** By default, one file: `~/.exhale/settings.json`, holding the time you gave consent and your history preference. If you turn on history, each run adds one summary line to `~/.exhale/history.jsonl`: duration, percent with the guide, start and end breathing rate, and the number of look-away reminders. No waveforms, no raw samples, no video. Both files are readable only by your user (mode 600).

**Retention and deletion.** History is kept until you delete it. "Delete all Exhale data" in the settings page removes both files and resets consent. Turning history off deletes the history file. In Docker, data lives in the `exhale-data` volume (`docker volume rm exhale_exhale-data`).

**Sharing.** Nothing is shared with anyone. The local server listens on `127.0.0.1` only. It rejects requests from other websites (it requires a custom header and checks the Origin) and from non-loopback host names (to block DNS rebinding).

**Not medical.** Exhale is a breathing exercise and a screen-break reminder. It does not diagnose, treat or monitor any condition, and you should not use it to make health decisions.

## Tests

```bash
npm test            # 32 unit + integration tests (state machine, scoring, server, CLI, protobuf decoding)
npm run test:e2e    # 7 end-to-end tests driving the real Electron app with Playwright (simulated sensor)
```

## Layout

```
src/core/       pacer, sync scoring, blink tracker, session state machine (pure, tested)
src/engine/     SmartSpectra SDK wrapper, run in a fresh child process per session so a native
                crash can't take the app down; plus the simulated sensor (same frame shape)
src/server.js   local HTTP + SSE API, hooks endpoint, static UI
src/ui/         the card (canvas sky, sun, horizon) and the settings page
src/electron/   menu-bar app and always-on-top overlay window
bin/exhale.js   serve | run | hooks | replay
```

## Licences

Exhale's own code is MIT. The SmartSpectra SDK is Presage's software under its own licence. The Bricolage Grotesque font is under the SIL Open Font Licence.

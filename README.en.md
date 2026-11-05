# Playlist Auto-Liker
---
**Local-first Chromium extension that traverses YouTube playlists and automatically likes unliked videos.**
100% private by design: zero servers, zero telemetry or data collection. Audited for uncompromised performance and safety.

[Español](README.md) · English

## Privacy & Security

- **Local-first and private by default**: runs entirely inside your browser. No backend, no external databases, and zero tracking or telemetry calls.
- **No personal data collection**: credentials, session tokens, and account data are never touched, read, or stored. Actions interact exclusively with standard accessible DOM elements on YouTube.
- **Strictly local storage**: your liked history and interval configuration remain strictly on your machine using `chrome.storage.local`.
- **Auditable zero-dependency code**: built with clean vanilla JavaScript, without obfuscation or third-party runtime npm packages.
- **Least-privilege permissions**: requests only `storage` (local settings and history), `scripting` (tab injection), and host access restricted to `https://www.youtube.com/*`.

## Installation

1. Download the repository:
   - Click the green **Code** button at the top right and select **Download ZIP** (or clone the repository).
   - Unpack the downloaded ZIP archive on your computer.
2. Open your browser's extensions page:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the **`extension`** folder inside the extracted repository.
6. Pin the extension to your toolbar for quick access.

### Browser Compatibility (Brave, Chrome, Edge)

The extension is 100% compatible with any Chromium-based browser.
- **Brave**: fully compatible out of the box. Native Brave Shields block YouTube ads before loading, resulting in faster and smoother runs without waiting for ads. Keep Shields on standard settings (do not enable aggressive "Block scripts"). When running large playlists in the background, consider adding `youtube.com` under `brave://settings/system` ("Sites that should never be made inactive") to prevent tab throttling from pausing execution timers.
- **Chrome & Edge**: standard native behavior with zero extra configuration required.

## Usage

1. Open a video that is part of a YouTube playlist. The URL must include `list=`.
2. Click the extension icon in your browser toolbar.
3. Choose the **traversal direction**:
   - **Ascending** (default): from the current video toward the end, in the playlist's original order.
   - **Descending**: from the current video toward the beginning of the playlist.
4. Select the interval mode:
   - **Fixed**: waits the exact configured number of seconds.
   - **Random range**: picks an integer interval between minimum and maximum seconds.
5. Click **Iniciar** (Start).

The extension starts from the current video and traverses the playlist in the selected direction:

- If the video **already has a Like**, it skips it immediately without waiting.
- If it **does not have a Like**, it waits for the configured interval, clicks Like, verifies the change, and advances.
- If the video was already liked by this extension during an earlier run, it will not click Like again.
- It stops upon reaching the end (ascending) or beginning (descending) of the playlist, or when clicking **Detener** (Stop).

During execution, an on-screen floating panel appears in the bottom-left corner of YouTube with live status, a countdown, and **Pausar/Reanudar** (Pause/Resume) and **Detener** (Stop) buttons. It can be collapsed into a minimal pill.

**Pausar** freezes execution and countdown. **Reanudar** continues from the exact state. **Detener** cancels the run; you can start again from whatever video is currently loaded.

Settings are saved automatically and persist across browser sessions. Changing the interval during a run applies live to the active countdown or the next video. Changing direction applies to the next started run.

## Edge Cases

- **Advertisements**: pauses and waits until ads finish before reading or clicking the Like button.
- **Slow loading**: waits for DOM elements to confirm the active video ID; never likes the previous video.
- **Unavailable videos**: skips unplayable items; stops with a clear message after repeated advance failures.
- **Manual video changes**: if the video changes during countdown, the pending like is canceled and the new video is processed.
- **Video near end**: if remaining duration is shorter than the interval (or the tab is hidden), playback is paused temporarily and resumed after liking to prevent autoplay skips.
- **Descending navigation**: navigates via the playlist panel item instead of the player's Previous button, preventing the YouTube bug where Previous restarts the current video instead of moving back.
- **Playlist boundaries**: detects the true start/end via YouTube's global counter (including virtualized lists with hundreds of items) or when player navigation controls are disabled.
- **Unauthenticated sessions**: if YouTube fails to confirm the Like state mutation, an error is reported and execution continues.

## Project Structure

```
extension/             Clean folder ready to load in the browser
  manifest.json        Extension manifest (Manifest V3)
  src/lib.js           Shared pure helpers and configuration normalizer
  src/content.js       State machine, DOM automation, and Shadow DOM HUD
  src/popup.html/css/js Popup interface and configuration controls
  icons/               Extension icons (16, 32, 48, 128 px)
tests/                 Unit tests and browser DOM test harness
ARCHITECTURE.md        Technical architecture, state machine, and data flow
CHANGELOG.md           Historical changelog and version release notes
LICENSE                MIT License
README.md              Spanish documentation
README.en.md           English documentation
```

## Development

Unit tests run natively without external dependencies:

```bash
node --test
```

A simulated YouTube DOM test harness is included. Serve the project root (e.g. with `python -m http.server 8765`), open `http://127.0.0.1:8765/tests/harness.html`, and inspect `window.__TEST_RESULTS__` or the on-screen report.

To test manual changes, reload the extension in `chrome://extensions` and refresh the YouTube tab.

## Permissions

- `storage`: persists configuration and the liked-video history.
- `scripting`: injects the content script dynamically if a YouTube playlist tab was opened prior to extension installation.
- Host permission `https://www.youtube.com/*`: reads player and playlist panel state and clicks standard UI controls.

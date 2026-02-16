# 3ABN Radio Recorder & Player Suite

A robust suite of Node.js services for recording 3ABN Radio streams, playing them back with a time-shift, and maintaining transmitter uptime.

## Components

1.  **threeabn-recorder**: Automatically scrapes the 3ABN schedule and records programs using `mpv`. Handles schedule changes, timezones, and ensures seamless recording across days.
2.  **threeabn-player**: Plays back the recorded content with a configurable time delay (default 2 hours). Features crossfading, fallback search for missing content, and automatic filler music insertion for gaps or failures.
3.  **ecreso-keepalive**: A watchdog service for Ecreso FM transmitters. Monitors forward power via the web interface and restarts the transmitter if power drops to 0.

## Prerequisites

- **Node.js**: v14+ (ES Module support required)
- **mpv**: For recording and playback
- **ffprobe** (part of ffmpeg): For media analysis
- **Puppeteer Dependencies**: Libraries required by Chrome for Linux

## Installation

1.  **Install Node Dependencies**:
    ```bash
    npm install
    ```

2.  **Install User-Level Systemd Services**:
    This script installs and enables the services for the current user (no root required for operation, though sudo may be asked to clean up old root services).
    ```bash
    ./install-services.sh
    # Or
    npm run install-services
    ```

## Configuration

Each service is configured via constants at the top of its respective JavaScript file.

### threeabn-recorder.js
*   `RECORD_BASE`: Directory where recordings are saved (default: `~/0Radio/3abn`).
*   `SCHED_TMP_DIR`: Temporary storage for schedule JSONs (default: `/tmp/3abn-sched`).
*   `GRACE_PERIOD_SECONDS`: Allowable delay before skipping a recording (self-tuning).

### threeabn-player.js
*   `SLOT_DELAY_SECONDS`: Time shift delay in seconds (default: `7200` = 2 hours).
*   `MUSIC_BASE`: Directory for filler music (default: `~/0Radio/RadioMusic`).
*   `CROSSFADE_DURATION`: Crossfade overlap in seconds (default: `5`).
*   `AUDIO_DEVICE`: Specify the MPV audio device. Selection logic:
    1.  Uses `AUDIO_DEVICE` environment variable if set.
    2.  Attempts to discover a USB Audio device via `mpv --audio-device=help`.
    3.  Falls back to `alsa/plughw:CARD=Device,DEV=0`.

### ecreso-keepalive.js
Configure the transmitter connection in the `CONFIG` object at the top of the file:
```javascript
const CONFIG = {
  IP: '192.168.2.206',      // Transmitter IP
  USER: 'Admin',            // Web Interface Username
  PASS: 'admin',            // Web Interface Password
  SCREEN_NAME: 'Puppeteer',
  RESTART_HOUR: 3,          // Hour (0-23) to restart browser daily
  PING_INTERVAL_MS: 60000   // Connectivity check interval
};
```

## Usage

Services are managed via `systemctl --user`.

**Start/Stop**:
```bash
systemctl --user start threeabn-player
systemctl --user stop threeabn-player
systemctl --user restart threeabn-recorder ecreso-keepalive
```

**View Status**:
```bash
systemctl --user status threeabn-player
```

**View Logs**:
Use the `--user` flag and `-f` to follow the log output in real-time.
```bash
# Recorder Logs
journalctl --user -u threeabn-recorder -f

# Player Logs
journalctl --user -u threeabn-player -f

# Keeper Logs
journalctl --user -u ecreso-keepalive -f
```

## Development & Testing

An automated test suite is included to verify core logic (time parsing, date boundaries, cache logic, fallback search, and duration validation).

**Run Tests**:
```bash
npm test
```

The tests cover:
*   **Time Parsing**: Verifies correct conversion of "12:30 PM" to seconds, including midnight handling.
*   **Date Boundaries**: Ensures correct handling of end-of-month, leap years, and timezone edge cases.
*   **Duration Validation**: Verifies logic for detecting recordings that are too short (>5s under) or valid.
*   **Fallback Logic**: Simulates searching for files in previous days' directories.
*   **Cache Persistence**: Verifies `song_cache.json` save/load logic.

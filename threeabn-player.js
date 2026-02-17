#!/usr/bin/env node

/**
 * 3ABN Radio player daemon using mpv and IPC.
 *
 * - Manages crossfading between recordings and filler music.
 * - Enforces slot boundaries from schedule.
 * - Handles missing recordings by searching past days.
 * - Provides Station ID overrides with ducking.
 */

import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import net from 'net';

const execPromise = promisify(exec);

// ===================== CONFIG ==========================

const CROSSFADE_DURATION = 5; // seconds for the volume ramp
const MPV_START_LAG = 8;      // estimated seconds for mpv to start and IPC to connect
const SLOT_DELAY_SECONDS = 2 * 3600;  // 2 hours behind current time
const SCHED_TMP_DIR = '/tmp/3abn-sched';
const RECORD_BASE = path.join(os.homedir(), '0Radio', '3abn');
const MUSIC_BASE = path.join(os.homedir(), '0Radio', 'Music');
const SONG_CACHE_FILE = path.join(MUSIC_BASE, 'song_cache.json');
const RAND_QUEUE_FILE = path.join(MUSIC_BASE, 'randsongs.json');
const OVERRIDE_BASE = path.join(os.homedir(), '0Radio');
const OVERRIDE_FILE = path.join(OVERRIDE_BASE, 'overrides.json');


// Audio Device Config (Default: USB Audio Device if discovered)
let AUDIO_DEVICE = 'alsa/plughw:CARD=Device,DEV=0';

async function discoverAudioDevice() {
  try {
    const { stdout } = await execPromise('aplay -l');
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('USB Audio Device') || line.includes('USB PnP Audio Device')) {
        const m = line.match(/card (\d+):.*device (\d+):/);
        if (m) {
          log(`Discovered USB Audio at card ${m[1]}, device ${m[2]}`);
          return `alsa/plughw:CARD=${m[1]},DEV=${m[2]}`;
        }
      }
    }
  } catch (e) {
    log('Audio discovery failed, falling back to system default.');
  }
  return ''; // Default
}

// ===================== PLAYER ==========================

class MpvPlayer {
  constructor(id) {
    this.id = id;
    this.socketPath = `/tmp/mpv-socket-${id}`;
    this.process = null;
    this.socket = null;
    this.stopping = false;
  }

  async start(file, startTime = 0) {
    log(`[Player ${this.id}] Starting mpv on ${path.basename(file)} from ${startTime}s`);

    this.stopping = false;

    // Ensure socket doesn't exist
    try { fs.unlinkSync(this.socketPath); } catch (e) { }

    this.process = spawn('mpv', [
      `--audio-device=${AUDIO_DEVICE}`,
      `--input-ipc-server=${this.socketPath}`,
      '--no-video',
      '--msg-level=all=warn', // Filter noise
      '--no-terminal',        // Prevent status line control chars
      `--volume=${this.initialVolume || 0}`, // Start silent or ducked
      `--start=${startTime}`,
      file
    ], { stdio: ['ignore', 'ignore', 'pipe'] }); // Capture stderr

    // Log stderr
    this.process.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) log(`[Player ${this.id}] mpv stderr: ${msg}`);
    });

    this.process.on('close', (code) => {
      if (code !== 0 && code !== null && !this.stopping) {
        log(`[Player ${this.id}] mpv exited with code ${code}`);
      }
    });

    // Wait for socket file
    let socketFound = false;
    for (let i = 0; i < 50; i++) {
      if (this.process.exitCode !== null) {
        throw new Error(`mpv process exited early (code ${this.process.exitCode})`);
      }
      if (fs.existsSync(this.socketPath)) {
        socketFound = true;
        break;
      }
      await sleep(100);
    }
    if (!socketFound) throw new Error(`mpv socket file not found after 5s`);

    // Connect IPC
    await new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);

      const onConnect = () => {
        this.socket.removeListener('error', onError);
        resolve();
      };
      const onError = (e) => {
        this.socket.removeListener('connect', onConnect);
        reject(new Error(`Socket connection failed: ${e.message}`));
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
    });

    this.socket.on('error', (e) => {
      // Ignore EPIPE/ECONNRESET if process is dead or intentionally stopping
      if (this.process && this.process.exitCode === null && !this.stopping) {
        log(`[Player ${this.id}] Socket error:`, e.message);
      }
    });

    log(`[Player ${this.id}] IPC connected.`);
  }

  setVolume(vol) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;

    try {
      const cmd = JSON.stringify({ command: ['set_property', 'volume', vol] }) + '\n';
      if (this.socket && !this.socket.destroyed && this.socket.writable) {
        this.socket.write(cmd, (err) => { });
      }
    } catch (e) {
      // Ignore sync errors
    }
  }

  async getProperty(name) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return null;
    return new Promise((resolve) => {
      const requestId = Math.floor(Math.random() * 10000);
      const onData = (data) => {
        try {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const res = JSON.parse(line);
            if (res.request_id === requestId) {
              this.socket.removeListener('data', onData);
              resolve(res.data);
              return;
            }
          }
        } catch (e) { }
      };
      this.socket.on('data', onData);
      const cmd = JSON.stringify({ command: ['get_property', name], request_id: requestId }) + '\n';
      this.socket.write(cmd);
      // Timeout
      setTimeout(() => {
        this.socket.removeListener('data', onData);
        resolve(null);
      }, 1000);
    });
  }

  stop() {
    this.stopping = true;
    if (this.process) {
      this.process.kill(); // Terminate
      this.process = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    try { fs.unlinkSync(this.socketPath); } catch (e) { }
  }
}

// ===================== LIBRARY =======================

class SongLibrary {
  constructor() {
    this.cache = {}; // file -> duration
    this.queue = [];
  }

  async loadCache() {
    try {
      if (fs.existsSync(SONG_CACHE_FILE)) {
        this.cache = JSON.parse(await fsp.readFile(SONG_CACHE_FILE, 'utf-8'));
      }
      if (fs.existsSync(RAND_QUEUE_FILE)) {
        this.queue = JSON.parse(await fsp.readFile(RAND_QUEUE_FILE, 'utf-8'));
      }
    } catch (e) { }
  }

  async getDuration(file) {
    if (this.cache[file]) return this.cache[file];
    try {
      const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`);
      const dur = parseFloat(stdout.trim());
      if (!isNaN(dur)) {
        this.cache[file] = dur;
        fsp.writeFile(SONG_CACHE_FILE, JSON.stringify(this.cache, null, 2)).catch(() => { });
        return dur;
      }
    } catch (e) { }
    return 0;
  }

  async getNextRandomSong() {
    if (!this.queue.length) {
      log('Queue empty, scanning music library...');
      await this.rescan();
    }
    const next = this.queue.shift();
    await fsp.writeFile(RAND_QUEUE_FILE, JSON.stringify(this.queue, null, 2));

    let dur = this.cache[next];
    if (!dur) {
      dur = await this.getDuration(next);
      if (dur > 0) {
        this.cache[next] = dur;
        // Best effort save
        fsp.writeFile(SONG_CACHE_FILE, JSON.stringify(this.cache, null, 2)).catch(e => { });
      }
    }

    return { path: next, duration: dur || 0 };
  }

  async rescan() {
    const walk = async (dir) => {
      let files = [];
      const list = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of list) {
        const res = path.resolve(dir, entry.name);
        if (entry.isDirectory()) files = files.concat(await walk(res));
        else if (entry.name.endsWith('.mp3') || entry.name.endsWith('.ogg')) files.push(res);
      }
      return files;
    };
    const all = await walk(MUSIC_BASE);
    // Shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    this.queue = all;
    await fsp.writeFile(RAND_QUEUE_FILE, JSON.stringify(this.queue, null, 2));
    log(`Queued ${all.length} songs.`);
  }
}

class OverrideManager {
  constructor() {
    this.overrides = [];
    this.lastLoad = 0;
  }

  async reloadIfStale() {
    const now = Date.now();
    if (now - this.lastLoad < 60000) return; // Once per min
    this.lastLoad = now;

    try {
      const data = await fsp.readFile(OVERRIDE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      this.overrides = parsed.map(o => ({
        ...o,
        seconds: this.parseTimeToSeconds(o.time),
        path: path.resolve(OVERRIDE_BASE, o.path)
      }));
      // log(`Loaded ${this.overrides.length} overrides from ${OVERRIDE_FILE}`);
    } catch (e) {
      if (e.code !== 'ENOENT') log('Error loading overrides:', e.message);
      this.overrides = [];
    }
  }

  parseTimeToSeconds(t) {
    const [h, m, s] = t.split(':').map(x => parseInt(x, 10));
    return h * 3600 + m * 60 + s;
  }

  getMatchingOverride(date, secondsSinceMidnight) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDay = days[date.getDay()];

    return this.overrides.find(o => {
      const dayMatch = (o.day === 'Any' || o.day === currentDay);
      return dayMatch && o.seconds === secondsSinceMidnight;
    });
  }
}

const overrideManager = new OverrideManager();
const library = new SongLibrary();

// ===================== MAIN LOOP =======================

async function mainLoop() {
  AUDIO_DEVICE = await discoverAudioDevice();
  await library.loadCache();
  // Initial scan if empty logic is handled in getNextRandomSong, but good to check on boot

  const player1 = new MpvPlayer(1);
  const player2 = new MpvPlayer(2);
  const player3 = new MpvPlayer(3); // Override player
  let activePlayer = null; // ref to p1 or p2
  let isDucked = false;

  // Helper to crossfade to new file
  const crossfadeTo = async (file, startOffset = 0) => {
    const next = activePlayer === player1 ? player2 : player1;
    const current = activePlayer;

    log(`Crossfading to ${path.basename(file)}...`);
    next.initialVolume = isDucked ? 10 : 0;
    await next.start(file, startOffset);

    if (isDucked) {
      activePlayer = next;
      if (current) current.stop();
      return;
    }

    // Wait for actual playback to start before ramping
    log(`[Player ${next.id}] Waiting for playback to start...`);
    for (let i = 0; i < 50; i++) {
      if (next.process.exitCode !== null) {
        throw new Error(`mpv process exited early (code ${next.process.exitCode})`);
      }
      const pos = await next.getProperty('time-pos');
      if (pos !== null && pos > 0) break;
      await sleep(100);
    }

    log(`[Player ${next.id}] Playback started, beginning ramp.`);

    // Animate
    const steps = 20;
    const dur = CROSSFADE_DURATION * 1000;
    const stepTime = dur / steps;

    for (let i = 0; i <= steps; i++) {
      const vol = Math.floor(i * (100 / steps));
      next.setVolume(vol);
      if (current) current.setVolume(100 - vol);
      await sleep(stepTime);
    }

    if (current) current.stop();
    activePlayer = next;
  };

  let retryCount = 0;
  let lastAttemptedFile = null;
  let failedFile = null;

  while (true) {
    try {
      // 1. Determine Time
      const now = new Date();
      const playbackTime = new Date(now.getTime() - SLOT_DELAY_SECONDS * 1000);

      // 2. Load Schedule
      const dateStr = formatDate(playbackTime);
      const schedFile = path.join(SCHED_TMP_DIR, `${dateStr}.json`);
      let schedule = [];
      try {
        const d = JSON.parse(await fsp.readFile(schedFile, 'utf-8'));
        schedule = d.schedule;
      } catch (e) {
        // log('Schedule not found...');
      }

      // 3. Find Slot
      const pbSeconds = playbackTime.getHours() * 3600 + playbackTime.getMinutes() * 60 + playbackTime.getSeconds();

      let currentSlot = null;
      if (schedule && schedule.length) {
        currentSlot = schedule.find((item, i) => {
          const next = schedule[i + 1];
          const end = next ? next.secondsSinceMidnight : 86400;
          return pbSeconds >= item.secondsSinceMidnight && pbSeconds < end;
        });
      }

      // 4. Determine Content Source
      let fileToPlay = null;
      let offset = 0;
      let duration = 0;
      let isFiller = false;

      if (currentSlot) {
        const slotEnd = schedule.find((_, i) => schedule[i - 1] === currentSlot)?.secondsSinceMidnight || 86400;
        const remainingInSlot = slotEnd - pbSeconds;

        // Fallback Finding Logic
        const findFile = async (dStr, code) => {
          let targetDir = path.join(RECORD_BASE, dStr.split('-').join(path.sep));
          try {
            const files = await fsp.readdir(targetDir);
            const match = files.find(f => f.includes(`-${code}-`) || f.includes(`${code}.mp3`));
            if (match) return path.join(targetDir, match);
          } catch (e) { }

          let curr = new Date(dStr);
          for (let i = 0; i < 30; i++) {
            curr.setDate(curr.getDate() - 1);
            const pastStr = formatDate(curr);
            targetDir = path.join(RECORD_BASE, pastStr.split('-').join(path.sep));
            try {
              const files = await fsp.readdir(targetDir);
              const match = files.find(f => f.includes(`-${code}-`));
              if (match) {
                log(`Found fallback recording in ${pastStr}`);
                return path.join(targetDir, match);
              }
            } catch (e) { }
          }
          return null;
        };

        let recFile = await findFile(dateStr, currentSlot.program_code);

        // Check if this file previously failed
        if (recFile && recFile === failedFile) {
          log(`Skipping previously failed file: ${path.basename(recFile)}`);
          recFile = null;
        }

        if (recFile) {
          // Validate Duration
          // 1. Calculate Expected Duration
          const idx = schedule.indexOf(currentSlot);
          const nextStart = schedule[idx + 1] ? schedule[idx + 1].secondsSinceMidnight : 86400;
          const slotDuration = nextStart - currentSlot.secondsSinceMidnight;

          // 2. Probe Actual Duration
          log(`Validating recording: ${path.basename(recFile)} (Slot: ${slotDuration}s)`);
          const actualDuration = await library.getDuration(recFile);

          const diff = actualDuration - slotDuration;

          if (diff < -5) {
            // Too short (>5s under)
            log(`Recording too short! Expected ~${slotDuration}s, got ${actualDuration}s (Diff: ${diff}s). Deleting and using filler.`);
            try {
              await fsp.unlink(recFile);
              log(`Deleted short recording: ${recFile}`);
            } catch (e) {
              log(`Failed to delete short recording: ${e.message}`);
            }
            recFile = null;
            isFiller = true;
          } else if (diff > 5) {
            // Too long (>5s over)
            log(`Recording is longer than slot (${actualDuration}s > ${slotDuration}s). Will play and fade out at slot end.`);
          } else {
            log(`Recording duration good (${actualDuration}s).`);
          }

          if (recFile) {
            fileToPlay = recFile;
            offset = pbSeconds - currentSlot.secondsSinceMidnight;
            duration = remainingInSlot;
          }
        } else {
          isFiller = true;
        }
      } else {
        isFiller = true;
      }

      // 5. Play Logic
      if (isFiller) {
        const song = await library.getNextRandomSong();
        if (song && song.path) {
          fileToPlay = song.path;
          offset = 0;
          duration = song.duration;
        }
      }

      // Reset retry count if we switched files
      if (fileToPlay !== lastAttemptedFile) {
        retryCount = 0;
        lastAttemptedFile = fileToPlay;
      }

      if (fileToPlay) {

        // Calculate sleep time
        // We want the crossfade animation to FINISH at the ideal end time.
        // Total transition time = MPV_START_LAG + CROSSFADE_DURATION.
        const transitionTotal = MPV_START_LAG + CROSSFADE_DURATION;

        let sleepSec = duration - transitionTotal;

        if (currentSlot) {
          const idx = schedule.indexOf(currentSlot);
          const nextStart = schedule[idx + 1] ? schedule[idx + 1].secondsSinceMidnight : 86400;
          const remainingInSlot = (nextStart - pbSeconds) - transitionTotal;
          if (remainingInSlot < sleepSec) {
            sleepSec = remainingInSlot;
          }
        }

        if (sleepSec < 0) sleepSec = 0;

        // Monitor Playback with Override Checking
        const runPlayback = async (totalSec) => {
          const startTime = Date.now();
          const endTime = startTime + totalSec * 1000;

          while (Date.now() < endTime) {
            // Check for Overrides (Wall Clock Local Time)
            const nowReal = new Date();
            const realSecs = nowReal.getHours() * 3600 + nowReal.getMinutes() * 60 + nowReal.getSeconds();

            await overrideManager.reloadIfStale();
            const ovr = overrideManager.getMatchingOverride(nowReal, realSecs);

            if (ovr) {
              log(`[Override] Triggering ${path.basename(ovr.path)} for ${ovr.duration}s`);
              // Duck
              isDucked = true;
              for (let v = 100; v >= 10; v -= 10) {
                player1.setVolume(v);
                player2.setVolume(v);
                await sleep(100);
              }

              // Play Override
              player3.initialVolume = 100;
              await player3.start(ovr.path);

              const ovrDur = ovr.duration;
              // Fade in override
              for (let v = 0; v <= 100; v += 10) {
                player3.setVolume(v);
                await sleep(100);
              }

              // Wait for override duration (minus fades)
              await sleep((ovrDur - 2) * 1000);

              // Fade out override
              for (let v = 100; v >= 0; v -= 10) {
                player3.setVolume(v);
                await sleep(100);
              }
              player3.stop();

              // Unduck
              isDucked = false;
              for (let v = 10; v <= 100; v += 10) {
                player1.setVolume(v);
                player2.setVolume(v);
                await sleep(100);
              }
              log('[Override] Finished.');
            }

            if (activePlayer && activePlayer.process && activePlayer.process.exitCode !== null && !activePlayer.stopping) {
              throw new Error(`MPV exited early (code ${activePlayer.process.exitCode})`);
            }
            if (activePlayer && !activePlayer.stopping && (!activePlayer.socket || activePlayer.socket.destroyed)) {
              throw new Error(`MPV IPC socket is dead or missing`);
            }

            // Sleep 1s but don't overshoot
            const remaining = endTime - Date.now();
            if (remaining > 0) {
              await sleep(Math.min(1000, remaining));
            }
          }
        };

        try {
          await crossfadeTo(fileToPlay, offset);
          log(`Playing ${path.basename(fileToPlay)} (Remaining: ${sleepSec}s)`);
          await runPlayback(sleepSec);
        } catch (e) {
          log(`Playback Error: ${e.message}`);
          // Retry Logic
          if (retryCount < 1) {
            log('Retrying once in 1s...');
            retryCount++;
            await sleep(1000);
            continue; // Restart loop to try same file again
          } else {
            log('Playback failed after retry. Marking file as failed and switching to filler.');
            if (fileToPlay === lastAttemptedFile) {
              failedFile = fileToPlay;
            }
            retryCount = 0;
            continue; // Restart loop (will see failedFile and skip it)
          }
        }

      } else {
        log('Nothing to play found (no songs?), sleeping 5s');
        await sleep(5000);
      }

    } catch (e) {
      log('Error in main loop:', e);
      await sleep(5000);
    }
  }
}

// Start
mainLoop().catch(e => { console.error(e); process.exit(1); });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

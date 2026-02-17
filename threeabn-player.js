#!/usr/bin/env node

/**
 * 3ABN Radio Player Daemon (Improved)
 *
 * Features:
 * - Plays scheduled content with fallback search.
 * - Time-shifted playback (2 hours delay).
 * - Fills gaps with random songs from local library.
 * - Uses mpv + IPC for crossfading.
 * - Caches song lengths to optimize filling.
 */

import fs from 'fs';
import { spawn, exec } from 'child_process';
import path from 'path';
import os from 'os';
import net from 'net';
import util from 'util';

const execPromise = util.promisify(exec);

const fsp = fs.promises;

// ===================== CONFIG ==========================

const SLOT_DELAY_SECONDS = 2 * 3600;  // 2 hours behind current time
const SCHED_TMP_DIR = '/tmp/3abn-sched';
const RECORD_BASE = path.join(os.homedir(), '0Radio', '3abn');
const MUSIC_BASE = path.join(os.homedir(), '0Radio', 'RadioMusic');
const SONG_CACHE_FILE = path.join(MUSIC_BASE, 'song_cache.json');
const RAND_QUEUE_FILE = path.join(MUSIC_BASE, 'randsongs.json');
const OVERRIDE_FILE = path.join(os.homedir(), '0Radio', 'scheduled.txt');
const OVERRIDE_BASE = path.join(os.homedir(), '0Radio');

// Audio Device Config (Default: USB Audio Device if discovered)
let AUDIO_DEVICE = 'alsa/plughw:CARD=Device,DEV=0';

async function discoverAudioDevice() {
  if (process.env.AUDIO_DEVICE) {
    log(`Using AUDIO_DEVICE from environment: ${process.env.AUDIO_DEVICE}`);
    return process.env.AUDIO_DEVICE;
  }

  try {
    const { stdout } = await execPromise("mpv --audio-device=help | grep 'USB Audio/Hardware' | cut -d \"'\" -f 2");
    const device = stdout.trim();
    if (device) {
      log(`Discovered USB Audio device: ${device}`);
      return device;
    }
  } catch (e) {
    // If grep fails (no match), it exits with code 1 which exec treats as error
  }

  log('Using default audio device'); //: alsa/plughw:CARD=Device,DEV=0');
  return ''; //alsa/plughw:CARD=Device,DEV=0';
}

// Playback logic
const CROSSFADE_DURATION = 5; // seconds

// ===================== UTILS =======================

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

// Simple wrapper for mpv IPC
class MpvPlayer {
  constructor(id) {
    this.id = id;
    this.socketPath = `/tmp/mpv-socket-${id}`;
    this.process = null;
    this.socket = null;
  }

  async start(file, startTime = 0) {
    log(`[Player ${this.id}] Starting mpv on ${path.basename(file)} from ${startTime}s`);

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
      if (code !== 0 && code !== null) {
        log(`[Player ${this.id}] mpv exited with code ${code}`);
      }
    });

    // Wait for socket
    for (let i = 0; i < 20; i++) {
      if (this.process.exitCode !== null) {
        throw new Error(`mpv process exited early (code ${this.process.exitCode})`);
      }
      if (fs.existsSync(this.socketPath)) break;
      await sleep(100);
    }

    // Connect IPC
    try {
      this.socket = net.createConnection(this.socketPath);
      this.socket.on('error', (e) => {
        // Ignore EPIPE/ECONNRESET if process is dead
        if (this.process && this.process.exitCode === null) {
          log(`[Player ${this.id}] Socket error:`, e.message);
        }
      });
    } catch (e) {
      log(`[Player ${this.id}] Failed to connect IPC:`, e.message);
    }
  }

  async setVolume(vol) {
    // vol 0-100
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;

    // Double check process
    if (this.process && this.process.exitCode !== null) return;

    try {
      const cmd = JSON.stringify({ command: ['set_property', 'volume', vol] }) + '\n';
      this.socket.write(cmd, (err) => {
        if (err) {
          // Log verbose only?
          // log(`[Player ${this.id}] Write error:`, err.message);
        }
      });
    } catch (e) {
      // Ignore sync errors
    }
  }

  stop() {
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


// ===================== SONG LIBRARY & CACHE =======================

class SongLibrary {
  constructor() {
    this.cache = {}; // path -> duration
    this.scanning = false;
  }

  async loadCache() {
    try {
      const data = await fsp.readFile(SONG_CACHE_FILE, 'utf-8');
      this.cache = JSON.parse(data);
    } catch (e) {
      log('No song cache found, scanning needed.');
    }
  }

  async scanLibrary() {
    if (this.scanning) return;
    this.scanning = true;
    log('Scanning music library...');

    try {
      const files = await this.recursiveFind(MUSIC_BASE);

      let changed = false;
      for (const f of files) {
        if (!this.cache[f]) {
          const dur = await this.getDuration(f);
          if (dur > 0) {
            this.cache[f] = dur;
            changed = true;
          }
        }
      }

      if (changed) {
        await fsp.mkdir(MUSIC_BASE, { recursive: true });
        await fsp.writeFile(SONG_CACHE_FILE, JSON.stringify(this.cache, null, 2));
        log(`Updated song cache with ${Object.keys(this.cache).length} songs.`);
      }
    } catch (e) {
      log('Error scanning library:', e);
    } finally {
      this.scanning = false;
    }
  }

  async recursiveFind(dir) {
    let results = [];
    try {
      const list = await fsp.readdir(dir);
      for (const f of list) {
        const full = path.join(dir, f);
        // Check if dir
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch (e) { continue; }

        if (stat.isDirectory()) {
          results = results.concat(await this.recursiveFind(full));
        } else if (/\.(mp3|ogg)$/i.test(f)) {
          results.push(full);
        }
      }
    } catch (e) {
      log('Error scanning dir:', dir, e.message);
    }
    return results;
  }

  async getDuration(file) {
    return new Promise(resolve => {
      const child = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file
      ]);
      let out = '';
      child.stdout.on('data', d => out += d);
      child.on('close', () => {
        const d = parseFloat(out.trim());
        resolve(isNaN(d) ? 0 : d);
      });
    });
  }

  async getNextRandomSong() {
    // Read Queue
    let queue = [];
    try {
      queue = JSON.parse(await fsp.readFile(RAND_QUEUE_FILE, 'utf-8'));
    } catch (e) { }

    if (queue.length === 0) {
      log('Queue empty, regenerating...');
      if (Object.keys(this.cache).length === 0) await this.scanLibrary();

      // Queue is list of paths
      const all = Object.keys(this.cache);
      if (all.length === 0) return null;

      // Shuffle
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      queue = all;
      await fsp.writeFile(RAND_QUEUE_FILE, JSON.stringify(queue));
    }

    const next = queue.shift();
    await fsp.writeFile(RAND_QUEUE_FILE, JSON.stringify(queue));

    // Verify duration
    let dur = this.cache[next];
    if (!dur) {
      log(`Duration missing for ${path.basename(next)}, probing...`);

      // Trigger background scan if cache might be incomplete/deleted
      if (!this.scanning) {
        log('Triggering background library scan to restore cache...');
        this.scanLibrary().catch(e => log('Background scan failed:', e));
      }

      dur = await this.getDuration(next);
      if (dur > 0) {
        this.cache[next] = dur;
        // Best effort save
        fsp.writeFile(SONG_CACHE_FILE, JSON.stringify(this.cache, null, 2)).catch(e => { });
      }
    }

    return { path: next, duration: dur || 0 };
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
      const lines = data.split('\n');
      const parsed = [];
      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const [day, time, durStr, ...pathParts] = line.split(/\s+/);
        const relPath = pathParts.join(' ');
        const absPath = path.resolve(OVERRIDE_BASE, relPath);
        parsed.push({
          day, // Any, Sun, Mon...
          time, // HH:MM:SS
          seconds: this.parseTimeToSeconds(time),
          duration: parseInt(durStr, 10),
          path: absPath
        });
      }
      this.overrides = parsed;
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
    // If not ducked, it starts at 0 and fades to 100.
    // If ducked, it starts at 10 and stays at 10.

    if (isDucked) {
      // No fade needed, just switch
      activePlayer = next;
      if (current) current.stop();
      return;
    }

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

        await crossfadeTo(fileToPlay, offset);

        // Calculate sleep time
        // Sleep = Duration - 2*Crossfade (to start next one early)

        let sleepSec = duration - 2 * CROSSFADE_DURATION;

        if (currentSlot) {
          const idx = schedule.indexOf(currentSlot);
          const nextStart = schedule[idx + 1] ? schedule[idx + 1].secondsSinceMidnight : 86400;
          const remainingInSlot = (nextStart - pbSeconds) - 2 * CROSSFADE_DURATION;
          if (remainingInSlot < sleepSec) {
            sleepSec = remainingInSlot;
          }
        }

        if (sleepSec < 0) sleepSec = 0;

        log(`Playing ${path.basename(fileToPlay)} (Remaining: ${sleepSec}s)`);

        // Monitor Playback with Override Checking
        const runPlayback = async (totalSec) => {
          let elapsed = 0;
          while (elapsed < totalSec) {
            // Check for Overrides
            const nowReal = new Date();
            const pbNow = new Date(nowReal.getTime() - SLOT_DELAY_SECONDS * 1000);
            const pbSecs = pbNow.getHours() * 3600 + pbNow.getMinutes() * 60 + pbNow.getSeconds();

            await overrideManager.reloadIfStale();
            const ovr = overrideManager.getMatchingOverride(pbNow, pbSecs);

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
              const ovrSteps = 10;
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

            if (activePlayer && activePlayer.process && activePlayer.process.exitCode !== null) {
              throw new Error(`MPV exited early (code ${activePlayer.process.exitCode})`);
            }

            await sleep(1000);
            elapsed += 1;

            // If we are nearing the end of slot while an override was playing, we might have overshot.
            // The loop condition elapsed < totalSec handles this.
          }
        };

        try {
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

#!/usr/bin/env node
/**
 * 3ABN Radio recorder daemon using Puppeteer + mpv.
 *
 * - Fetches daily schedule via SPA at https://r.3abn.org/sched-app/#/
 * - Records each upcoming program from the live stream into ~/0Radio/3abn/YYYY/MM/DD
 * - Uses mpv --stream-dump with overlap handoff (start new, then stop old)
 * - Cleans old schedules and puppeteer temp profiles in /tmp
 *
 * Requires: node, npm, puppeteer, mpv, systemd unit (below).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer';

const fsp = fs.promises;

// ======================== CONFIGURATION ==========================

// Seconds offset to adjust between stream time and system clock.
// Positive means: start recording this many seconds *earlier* than scheduled.
const STREAM_OFFSET_SECONDS = 10;

// How many seconds after the slot start we still allow starting recording
const GRACE_PERIOD_SECONDS = 5;

// Extra seconds to subtract to account for recorder startup overhead
const STARTUP_OVERHEAD_SECONDS = 2;

// Base directory for recordings.
const RECORD_BASE = path.join(os.homedir(), '0Radio', '3abn');

// Streaming URL to record from.
const STREAM_URL = 'https://war.streamguys1.com:7185/live';

// Where to store schedule JSON files.
const SCHED_TMP_DIR = '/tmp/3abn-sched';

// How many days of schedule files to keep.
const KEEP_SCHED_DAYS = 3;

// How many days to keep old puppeteer profiles.
const KEEP_PUPP_PROFILES_DAYS = 3;

// Channel type – if you later distinguish e.g. "radio" vs "tv" in the app.
const CHANNEL_NAME = 'Radio';

// =================================================================

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convert "06:15 PM" to seconds since midnight.
function parseTimeToSeconds(timeText) {
  const m = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!m) return null;
  let [, hStr, mStr, ap] = m;
  let h = parseInt(hStr, 10);
  const mm = parseInt(mStr, 10);
  ap = ap.toLowerCase();
  if (ap === 'am' && h === 12) h = 0;
  if (ap === 'pm' && h !== 12) h += 12;
  return h * 3600 + mm * 60;
}

// Format date as YYYY-MM-DD.
function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

// Puppeteer scrape of today’s schedule (radio).
async function fetchTodaySchedule() {
  log('Launching Puppeteer to fetch schedule...');
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--ignore-ssl-errors',
      '--no-sandbox',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    await page.goto('https://r.3abn.org/sched-app/#/radio', {
      waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
      timeout: 60000,
    });

    await sleep(3000);

    // NOTE: If a specific "Radio" network selection is required, add a
    // click on the "Select a Network" dropdown here using visible text.
    // For now we assume it is already set appropriately.

    // Expand all entries to reveal Program Title, Program Code, Host, etc.
    await page.evaluate(() => {
      document.querySelectorAll('.material-icons').forEach(icon => {
        if (icon.textContent.trim() === 'expand_more') {
          icon.click();
        }
      });
    });
    await sleep(2000);

    const rawItems = await page.evaluate(() => {
      const entries = Array.from(
        document.querySelectorAll('.sched-app-daily-entry')
      );

      return entries.map(entry => {
        const imgEl = entry.querySelector('.sched-app-daily-entry-img');
        let seriesImg = imgEl ? imgEl.src : '';
        let programCodeFromImg = '';
        if (seriesImg) {
          const m = seriesImg.match(/\/([^\/]+)\.(jpg|png|jpeg|gif)$/i);
          if (m) programCodeFromImg = m[1];
        }

        const titleEl = entry.querySelector('.sched-app-daily-entry-title');
        const seriesTitle = titleEl ? titleEl.textContent.trim() : '';

        const timeEl = entry.querySelector('.sched-app-daily-entry-time');
        const timeText = timeEl ? timeEl.textContent.trim() : '';

        const detailsSpan = entry.querySelector('.schedAppDailyEntryFull');
        let programTitle = '';
        let programCode = programCodeFromImg;
        let guest = '';

        if (detailsSpan) {
          const html = detailsSpan.innerHTML;

          const progTitleMatch = html.match(
            /<strong>Program Title:<\/strong>\s*(.*?)(?=<div|<strong|$)/i
          );
          if (progTitleMatch) {
            programTitle = progTitleMatch[1]
              .replace(/<\/?[^>]+(>|$)/g, '')
              .trim();
          }

          const progCodeMatch = html.match(
            /<strong>Program Code:<\/strong>\s*([^<\s][^<]*)/i
          );
          if (progCodeMatch) {
            programCode = progCodeMatch[1].trim();
          }

          const hostMatch = html.match(
            /<strong>Host:<\/strong>\s*(.*?)(?=<div|<strong|$)/i
          );
          if (hostMatch) {
            guest = hostMatch[1]
              .replace(/<\/?[^>]+(>|$)/g, '')
              .trim();
          }
        }

        return {
          series_title: seriesTitle,
          program_title: programTitle,
          program_code: programCode,
          series_img: seriesImg,
          timeText,
          guest,
        };
      }).filter(item => item.timeText);
    });

    const today = new Date();
    const todayStr = formatDate(today);

    // Generate fallback program titles and ISO dates.
    const schedule = rawItems.map(item => {
      const secondsSinceMidnight = parseTimeToSeconds(item.timeText);
      const isoDate = (() => {
        if (secondsSinceMidnight == null) {
          return `${todayStr}T00:00:00`;
        }
        const d = new Date(today);
        d.setHours(0, 0, 0, 0);
        d.setSeconds(secondsSinceMidnight);
        return d.toISOString().replace(/\.\d{3}Z$/, '');
      })();

      let programTitle = item.program_title;
      if (!programTitle) {
        programTitle = `${item.series_title || 'Program'} on ${todayStr}`;
      }

      return {
        series_title: item.series_title || '',
        program_title: programTitle || '',
        program_code: item.program_code || '',
        series_img: item.series_img || '',
        date: isoDate,
        guest: item.guest || '',
        timeText: item.timeText,
        secondsSinceMidnight,
      };
    });

    return {
      schedule,
      date: todayStr,
    };
  } finally {
    await browser.close();
  }
}

// Save schedule JSON to /tmp and clean old ones.
async function saveScheduleToTmp(scheduleObj) {
  await fsp.mkdir(SCHED_TMP_DIR, { recursive: true });
  const fname = path.join(SCHED_TMP_DIR, `${scheduleObj.date}.json`);
  await fsp.writeFile(fname, JSON.stringify(scheduleObj, null, 2));
  log('Saved schedule', fname);
  return fname;
}

async function cleanupOldFiles() {
  const now = Date.now();
  const schedThresholdMs = KEEP_SCHED_DAYS * 24 * 3600 * 1000;
  const puppThresholdMs = KEEP_PUPP_PROFILES_DAYS * 24 * 3600 * 1000;

  // Old schedule JSONs
  try {
    const files = await fsp.readdir(SCHED_TMP_DIR);
    for (const f of files) {
      const full = path.join(SCHED_TMP_DIR, f);
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > schedThresholdMs) {
        log('Removing old schedule file', full);
        await fsp.rm(full, { force: true });
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log('Error cleaning schedule files:', e.message);
  }

  // Old puppeteer profiles in /tmp
  try {
    const tmpFiles = await fsp.readdir('/tmp');
    for (const f of tmpFiles) {
      if (!f.startsWith('puppeteer_dev_chrome_profile-')) continue;
      const full = path.join('/tmp', f);
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > puppThresholdMs) {
        log('Removing old puppeteer profile', full);
        await fsp.rm(full, { recursive: true, force: true });
      }
    }
  } catch (e) {
    log('Error cleaning puppeteer profiles:', e.message);
  }
}

// Start mpv recording, return child process.
function startRecording(outFile) {
  log('Starting mpv recording to', outFile);
  const mpv = spawn(
    'mpv',
    [
      `--stream-dump=${outFile}`,
      '--vo=null',
      '--no-audio',
      STREAM_URL,
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    }
  );
  return mpv;
}

// Stop mpv child gracefully.
function stopRecording(child) {
  if (!child || child.killed) return;
  log('Stopping previous mpv PID', child.pid);
  child.kill('SIGTERM');
}

// Compute wait time (ms) until program start, applying stream offset.
function msUntilProgramStart(secsSinceMidnight) {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const nowSeconds = Math.floor((now - midnight) / 1000);
  let diffSeconds = secsSinceMidnight - nowSeconds;

  // Apply stream offset: start earlier if positive.
  diffSeconds -= STREAM_OFFSET_SECONDS;

  return diffSeconds * 1000;
}

// Main loop: for each program, either wait or record.
async function runToday() {
  const schedObj = await fetchTodaySchedule();
  await saveScheduleToTmp(schedObj);
  await cleanupOldFiles();

  const today = new Date();
  const todayStr = formatDate(today);

  // Ensure schedule is sorted by time.
  const items = schedObj.schedule
    .filter(item => item.secondsSinceMidnight != null)
    .sort((a, b) => a.secondsSinceMidnight - b.secondsSinceMidnight);

  if (!items.length) {
    log('No items found in schedule; sleeping until tomorrow.');
    return;
  }

  let previousMpv = null;

  for (let i = 0; i < items.length; i++) {
    const current = items[i];
    const next = items[i + 1] || null;

    const startMs = msUntilProgramStart(current.secondsSinceMidnight);
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const nowSeconds = Math.floor((now - midnight) / 1000);

    const alreadyStarted = nowSeconds > (current.secondsSinceMidnight + GRACE_PERIOD_SECONDS);

    const nextStartSeconds = next
      ? next.secondsSinceMidnight
      : 24 * 3600;
    const lengthSeconds = nextStartSeconds - current.secondsSinceMidnight;

    if (lengthSeconds <= 0) {
      log(
        'Skipping item with non-positive length:',
        current.series_title,
        current.program_code
      );
      continue;
    }

    if (alreadyStarted) {
      // If slot already started, skip recording and just wait its remaining length.
      log(
        'Slot already started; not recording partial:',
        current.series_title,
        current.program_code
      );
      const remaining = nextStartSeconds - nowSeconds;
      if (remaining > 0) {
        log('Sleeping remaining seconds in slot:', remaining);
        await new Promise(r => setTimeout(r, remaining * 1000));
      }
      continue;
    }

    if (startMs > 0) {
      log(
        'Waiting until next program start (ms):',
        startMs,
        current.series_title,
        current.program_code
      );
      await new Promise(r => setTimeout(r, startMs));
    } else {
      log('Start time already passed after offset; skipping start wait.');
    }

    // Build recording directory: ~/0Radio/3abn/YYYY/MM/DD
    const d = todayStr.split('-'); // [YYYY, MM, DD]
    const recDir = path.join(RECORD_BASE, d[0], d[1], d[2]);
    await fsp.mkdir(recDir, { recursive: true });

    const hour = String(
      Math.floor(current.secondsSinceMidnight / 3600)
    ).padStart(2, '0');

    const code = current.program_code || 'UNKNOWN';
    const len = lengthSeconds;

    const outFile = path.join(
      recDir,
      `${hour}-${code}-${len}.mp3`
    );

    // Start new recording first, THEN stop previous to avoid gaps.
    const mpv = startRecording(outFile);

    // Give mpv a moment to fully connect before stopping previous.
    await new Promise(r => setTimeout(r, 2000));

    if (previousMpv) {
      stopRecording(previousMpv);
    }
    previousMpv = mpv;

    // Sleep for duration of this slot.
    log(
      'Recording for seconds:',
      lengthSeconds,
      'Program:',
      current.series_title,
      current.program_title,
      current.program_code
    );
    await new Promise(r => setTimeout(r, lengthSeconds * 1000));
  }

  // After last slot ends, allow last mpv to be stopped.
  if (previousMpv) {
    stopRecording(previousMpv);
  }

  log('Finished today schedule; exiting runToday.');
}

async function mainLoop() {
  while (true) {
    try {
      await runToday();
    } catch (e) {
      log('Error in main loop:', e.stack || e);
    }

    // Sleep until a little after midnight and run again.
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 5, 0, 0); // 00:05 next day
    const ms = tomorrow - now;
    log('Sleeping ms until next run:', ms);
    await new Promise(r => setTimeout(r, ms));
  }
}

mainLoop().catch(e => {
    log('Fatal error:', e.stack || e);
    process.exit(1);
});

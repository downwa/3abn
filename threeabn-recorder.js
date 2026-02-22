#!/usr/bin/env node

/**
 * 3ABN Radio recorder daemon using Puppeteer + mpv.
 *
 * - Fetches daily schedule via SPA at https://r.3abn.org/sched-app/#/radio
 * - Records each upcoming program from the live stream.
 * - Manages Day Boundaries seamlessly by refetching schedules.
 * - Uses mpv --stream-dump with overlap handoff.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer';
import { analyzeFileForDTMF } from './dtmf-analyzer.js';

const fsp = fs.promises;

// ======================== CONFIGURATION ==========================

const SCHEDULE_PAGE = 'https://r.3abn.org/sched-app/#/radio';

// Base directory for recordings.
const RECORD_BASE = path.join(os.homedir(), '0Radio', '3abn');

// Seconds offset to adjust between stream time and system clock.
// Positive means: start recording this many seconds *earlier* than scheduled.
let STREAM_OFFSET_SECONDS = 10;
const OFFSET_FILE = path.join(RECORD_BASE, 'offset.json');

// Streaming URL to record from.
const STREAM_URL = 'https://war.streamguys1.com:7185/live';

// Where to store schedule JSON files.
const SCHED_TMP_DIR = '/tmp/3abn-sched';

// ======================== UTILS ==========================

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

async function loadOffset() {
  try {
    if (fs.existsSync(OFFSET_FILE)) {
      const data = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8'));
      if (typeof data.offset === 'number') {
        STREAM_OFFSET_SECONDS = data.offset;
        log(`Loaded STREAM_OFFSET_SECONDS from disk: ${STREAM_OFFSET_SECONDS}`);
      }
    }
  } catch (e) {
    log('Error loading offset.json:', e.message);
  }
}

async function saveOffset(val) {
  try {
    STREAM_OFFSET_SECONDS = val;
    await fsp.writeFile(OFFSET_FILE, JSON.stringify({ offset: val, lastUpdated: new Date().toISOString() }, null, 2));
    log(`Saved new STREAM_OFFSET_SECONDS: ${val}`);
  } catch (e) {
    log('Error saving offset.json:', e.message);
  }
}

// ======================== SCHEDULE MANAGER ==========================

class ScheduleManager {
  constructor() {
    this.cache = new Map(); // dateStr -> scheduleObject
    this.fetchPromises = new Map(); // dateStr -> Promise
  }

  /**
   * Ensures schedule for `dateStr` is available.
   * If valid file exists, loads it.
   * If not, fetches it (blocking if not background).
   */
  async getSchedule(dateStr) {
    if (this.cache.has(dateStr)) return this.cache.get(dateStr);

    // Disk Cache
    const filePath = path.join(SCHED_TMP_DIR, `${dateStr}.json`);
    try {
      const stats = await fsp.stat(filePath);
      if (stats.size > 0) {
        const content = await fsp.readFile(filePath, 'utf-8');
        const sched = JSON.parse(content);
        if (sched && Array.isArray(sched.schedule)) {
          // Verify date inside?
          this.cache.set(dateStr, sched);
          return sched;
        }
      }
    } catch (e) { /* ignore */ }

    // Fetch
    if (this.fetchPromises.has(dateStr)) return this.fetchPromises.get(dateStr);

    log(`Schedule for ${dateStr} missing locally. Fetching...`);
    const p = this.scrapeAndSave(dateStr).finally(() => this.fetchPromises.delete(dateStr));
    this.fetchPromises.set(dateStr, p);
    return p;
  }

  /**
   * Triggers a background fetch for `dateStr` if not already cached/fetching.
   */
  ensureInBackground(dateStr) {
    if (this.cache.has(dateStr)) return;

    const filePath = path.join(SCHED_TMP_DIR, `${dateStr}.json`);
    fsp.stat(filePath).then(stats => {
      if (stats.size > 0) {
        return fsp.readFile(filePath, 'utf-8').then(c => JSON.parse(c)).then(s => this.cache.set(dateStr, s));
      }
      throw new Error('Not found');
    }).catch(() => {
      if (!this.fetchPromises.has(dateStr)) {
        log(`[Background] Triggering fetch for ${dateStr}...`);
        const p = this.scrapeAndSave(dateStr).catch(err => {
          log(`[Background] Failed to fetch ${dateStr}:`, err.message);
        }).finally(() => this.fetchPromises.delete(dateStr));
        this.fetchPromises.set(dateStr, p);
      }
    });
  }

  async scrapeAndSave(targetDateStr) {
    log(`Launching Puppeteer for ${targetDateStr}...`);
    // Note: This logic assumes we mostly scrape "Today".
    // If targetDateStr is far in future, this might fail without nav logic.
    // But since we pre-download "Tomorrow" usually when "Today" is active,
    // "Tomorrow" *might* require button clicks.

    // For now, we use a simple approach: Load page. If date matches, good.
    // If not, we try to click "Next Day".

    const browser = await puppeteer.launch({
      headless: 'new',
      ignoreHTTPSErrors: true,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1024 });

      // Attempt to go to specific date if URL param supported (unlikely but harmless to try?)
      // Actually, let's just go to root.
      await page.goto(SCHEDULE_PAGE, { waitUntil: 'networkidle0', timeout: 60000 });
      await sleep(5000);

      // Check current displayed date?
      // Let's assume we need to scrape whatever is there, AND if we need next day, we click next.

      // Helper to scrape current view
      const scrapeCurrentView = async () => {
        // Expand all
        await page.evaluate(() => {
          document.querySelectorAll('.material-icons').forEach(i => {
            if (i.textContent.trim() === 'expand_more') i.click();
          });
        });
        await sleep(1000);

        return page.evaluate(() => {
          const entries = Array.from(document.querySelectorAll('.sched-app-daily-entry'));
          return entries.map(entry => {
            const timeEl = entry.querySelector('.sched-app-daily-entry-time');
            if (!timeEl) return null;
            const timeText = timeEl.textContent.trim();

            const imgEl = entry.querySelector('.sched-app-daily-entry-img');
            const seriesImg = imgEl ? imgEl.src : '';
            let programCode = '';
            if (seriesImg) {
              const m = seriesImg.match(/\/([^\/]+)\.(jpg|png|jpeg|gif)$/i);
              if (m) programCode = m[1];
            }

            const titleEl = entry.querySelector('.sched-app-daily-entry-title');
            const seriesTitle = titleEl ? titleEl.textContent.trim() : '';

            const detailsSpan = entry.querySelector('.schedAppDailyEntryFull');
            let programTitle = '';
            if (detailsSpan) {
              const html = detailsSpan.innerHTML;
              const pm = html.match(/<strong>Program Title:<\/strong>\s*(.*?)(?=<div|<strong|$)/i);
              if (pm) programTitle = pm[1].replace(/<\/?[^>]+(>|$)/g, '').trim();
              const cm = html.match(/<strong>Program Code:<\/strong>\s*([^<\s][^<]*)/i);
              if (cm) programCode = cm[1].trim();
            }
            if (!programTitle) programTitle = seriesTitle || 'Program';
            return { series_title: seriesTitle, program_title: programTitle, program_code: programCode, timeText };
          }).filter(Boolean);
        });
      };

      // Navigation Logic
      // Parse YYYY-MM-DD manually to avoid UTC shifts
      const [y, m, d] = targetDateStr.split('-').map(Number);
      const targetYear = y;
      const targetMonth = m - 1; // 0-indexed
      const targetDay = d;

      log(`Targeting Date: ${targetDateStr} (D:${targetDay} M:${targetMonth} Y:${targetYear})`);

      // 1. Check and Navigate Month
      // We loop because we might need to go multiple months? (Unlikely but safe)
      for (let tries = 0; tries < 5; tries++) {
        const title = await page.evaluate(() => {
          const el = document.querySelector('.c-title');
          return el ? el.textContent.trim() : '';
        });

        if (!title) break; // Error finding title

        // Parse "February 2026"
        const [mStr, yStr] = title.split(' ');
        const monthMap = {
          January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
          July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
        };
        const displayedMonth = monthMap[mStr];
        const displayedYear = parseInt(yStr);

        log(`Calendar shows: ${mStr} ${yStr}`);

        if (displayedYear === targetYear && displayedMonth === targetMonth) {
          break; // Correct month
        }

        // Decide direction (Assuming always future for now, or next month)
        // Simple logic: If target > displayed, click NEXT.
        const displayedVal = displayedYear * 12 + displayedMonth;
        const targetVal = targetYear * 12 + targetMonth;

        if (targetVal > displayedVal) {
          log('Navigating to Next Month...');
          const clicked = await page.evaluate(() => {
            // Click second arrow-layout (Next)
            // Structure: arrow, title, arrow
            const arrows = document.querySelectorAll('.c-arrow-layout');
            if (arrows.length >= 2) {
              arrows[arrows.length - 1].click(); // Last one should be next
              return true;
            }
            return false;
          });
          if (!clicked) throw new Error('Could not find Next Month arrow');
          await sleep(1000);
        } else {
          // Backward? Allow it just in case
          log('Navigating to Previous Month...');
          const clicked = await page.evaluate(() => {
            const arrows = document.querySelectorAll('.c-arrow-layout');
            if (arrows.length > 0) {
              arrows[0].click();
              return true;
            }
            return false;
          });
          if (!clicked) throw new Error('Could not find Prev Month arrow');
          await sleep(1000);
        }
      }

      // 2. Click Day
      log(`Clicking Day ${targetDay}...`);
      const dayClicked = await page.evaluate((day) => {
        // Find all .c-day-content with exact text
        const els = Array.from(document.querySelectorAll('.c-day-content'));
        const matches = els.filter(el => parseInt(el.textContent.trim()) === day);

        // Filter parent opacity
        // We want the one that does NOT have opacity style on .c-day (grandparent?)
        // Structure: .c-day > .c-day-content-wrapper > .c-day-content
        // Outer: .c-day

        for (const el of matches) {
          // Traverse up to .c-day
          let p = el.parentElement;
          while (p && !p.classList.contains('c-day')) {
            p = p.parentElement;
          }

          if (p) {
            const style = window.getComputedStyle(p);
            // Check opacity. Usually "0.4" for inactive.
            if (style.opacity && parseFloat(style.opacity) < 0.9) {
              continue; // Skip faded
            }
            // This is our day
            // Click the .c-day-content or wrapper?
            el.click();
            return true;
          }
        }
        return false;
      }, targetDay);

      if (!dayClicked) {
        log('Warning: Could not find clickable day, dumping current view.');
      } else {
        await sleep(2000); // Wait for load
      }

      const scrapedItems = await scrapeCurrentView();

      const schedule = scrapedItems.map(item => ({
        ...item,
        secondsSinceMidnight: parseTimeToSeconds(item.timeText)
      })).sort((a, b) => a.secondsSinceMidnight - b.secondsSinceMidnight);

      const schedObj = { date: targetDateStr, schedule };

      await fsp.mkdir(SCHED_TMP_DIR, { recursive: true });
      const fname = path.join(SCHED_TMP_DIR, `${targetDateStr}.json`);
      await fsp.writeFile(fname, JSON.stringify(schedObj, null, 2));
      log('Saved schedule to', fname);

      this.cache.set(targetDateStr, schedObj);
      return schedObj;

    } finally {
      await browser.close();
    }
  }
}

const scheduler = new ScheduleManager();

// ======================== RECORDING ==========================

function startRecording(outFile) {
  log('Starting mpv recording to', outFile);
  const mpv = spawn('mpv', [
    `--stream-dump=${outFile}`,
    '--vo=null',
    '--no-audio',
    STREAM_URL,
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });
  return mpv;
}

async function stopRecording(child) {
  if (child) {
    return new Promise((resolve) => {
      child.once('close', resolve);
      child.kill('SIGINT'); // Graceful stop to finalize MP3
      // Safety timeout
      setTimeout(resolve, 5000);
    });
  }
}


// ======================== CLEANUP ==========================

/**
 * Removes older files with the same program code, keeping only the most recent one.
 */
async function cleanupProgramDuplicates(code, keepFile) {
  if (!code || code === 'UNK') return;
  log(`[Cleanup] Searching for duplicates of code: ${code}`);

  const files = await recursiveList(RECORD_BASE);
  for (const f of files) {
    if (f !== keepFile && f.includes(`-${code}-`)) {
      try {
        await fsp.unlink(f);
        log(`[Cleanup] Deleted duplicate: ${path.basename(f)}`);
      } catch (e) {
        log(`[Cleanup] Failed to delete ${f}: ${e.message}`);
      }
    }
  }
  await removeEmptyDirs(RECORD_BASE);
}

/**
 * Daily cleanup: Remove files > 1 year old and all empty directories.
 */
async function dailyLegacyCleanup() {
  log('[Cleanup] Starting legacy 3AM purge...');
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 3600 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 3600 * 1000;

  // Cleanup recordings (> 1yr)
  const files = await recursiveList(RECORD_BASE);
  for (const f of files) {
    try {
      const stats = await fsp.stat(f);
      if (stats.mtimeMs < oneYearAgo) {
        await fsp.unlink(f);
        log(`[Cleanup] Deleted legacy file (>1yr): ${path.basename(f)}`);
      }
    } catch (e) {
      log(`[Cleanup] Error checking ${f}: ${e.message}`);
    }
  }
  await removeEmptyDirs(RECORD_BASE);

  // Cleanup schedule cache (> 30 days)
  try {
    if (fs.existsSync(SCHED_TMP_DIR)) {
      const schedFiles = await fsp.readdir(SCHED_TMP_DIR);
      for (const fname of schedFiles) {
        const fpath = path.join(SCHED_TMP_DIR, fname);
        const stats = await fsp.stat(fpath);
        if (stats.mtimeMs < thirtyDaysAgo) {
          await fsp.unlink(fpath);
          log(`[Cleanup] Deleted legacy schedule: ${fname}`);
        }
      }
    }
  } catch (e) {
    log(`[Cleanup] Error cleaning schedule cache: ${e.message}`);
  }

  log('[Cleanup] Legacy purge complete.');
}

async function recursiveList(dir) {
  let results = [];
  try {
    const list = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of list) {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(await recursiveList(res));
      } else {
        results.push(res);
      }
    }
  } catch (e) { /* ignore */ }
  return results;
}

async function removeEmptyDirs(dir) {
  try {
    const list = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of list) {
      if (entry.isDirectory()) {
        const res = path.resolve(dir, entry.name);
        await removeEmptyDirs(res);
      }
    }

    // Re-check after children cleaned
    const remaining = await fsp.readdir(dir);
    if (remaining.length === 0 && dir !== RECORD_BASE) {
      await fsp.rmdir(dir);
      log(`[Cleanup] Removed empty directory: ${dir}`);
    }
  } catch (e) { /* ignore */ }
}

// ======================== MAIN LOOP ==========================

async function runLoop() {
  log('Starting 3ABN Recorder Service...');

  let currentRecording = null; // { signature, process, outFile, endTime }
  let lastCleanupDay = '';

  // Load persistent offset
  await loadOffset();

  // Initial fetch of Today and background fetch of Tomorrow
  const nowStart = new Date();
  const todayStrStart = formatDate(nowStart);
  await scheduler.getSchedule(todayStrStart);

  const tmrStart = new Date(nowStart);
  tmrStart.setDate(tmrStart.getDate() + 1);
  scheduler.ensureInBackground(formatDate(tmrStart));

  while (true) {
    try {
      const now = new Date();
      // Use effective time (shifted by STREAM_OFFSET_SECONDS) for all scheduling logic
      const effectiveTime = new Date(now.getTime() + STREAM_OFFSET_SECONDS * 1000);
      const todayStr = formatDate(effectiveTime);

      // Get Today's schedule (fast from cache usually)
      const schedObj = await scheduler.getSchedule(todayStr); // should be cached

      const nowSeconds = effectiveTime.getHours() * 3600 + effectiveTime.getMinutes() * 60 + effectiveTime.getSeconds();

      // Find active slot
      let activeItem = null;
      for (let i = 0; i < schedObj.schedule.length; i++) {
        const item = schedObj.schedule[i];
        const next = schedObj.schedule[i + 1];
        // End is next start or 86400 (midnight)
        // Note: If schedule has gaps, this assumes continuous.
        // Most radio schedules are.
        const start = item.secondsSinceMidnight;
        const end = next ? next.secondsSinceMidnight : 86400;

        if (nowSeconds >= start && nowSeconds < end) {
          activeItem = { ...item, endTime: end };
          break;
        }
      }

      if (!activeItem) {
        // Could be 23:59:59 -> just wait
        log('No active slot found. Waiting...');
        await sleep(2000);
        continue;
      }

      // Check if we need to start/switch
      const signature = `${todayStr}/${activeItem.program_code}-${activeItem.timeText}`;

      // CONFIG values
      const GRACE_PERIOD_SECONDS = 5;
      const STARTUP_OVERHEAD_SECONDS = 2; // Configurable factor

      if (!currentRecording || currentRecording.signature !== signature) {

        // Calculate timing relative to slot start
        // activeItem.secondsSinceMidnight is the ideal start time.
        // nowSeconds is current time.

        const secondsPastStart = nowSeconds - activeItem.secondsSinceMidnight;

        if (secondsPastStart < 0) {
          // EARLY: We are ahead of schedule (e.g. previous ended early or just booted)
          // Wait until exact start time.
          const waitMs = Math.abs(secondsPastStart) * 1000;
          log(`Ready early for ${activeItem.program_code}. Waiting ${waitMs}ms to start exactly on time.`);
          await sleep(waitMs);
          // After sleep, we are at start time. Proceed immediately in next loop? 
          // Better to fall through and let loop re-evaluate? 
          // If we continue, loop re-evals. 
          // But we want to start NOW. 
          // Let's just update nowSeconds and proceed? 
          // Actually, safer to Continue and let loop catch it at 0s offset.
          continue;
        }

        if (secondsPastStart > GRACE_PERIOD_SECONDS) {
          // TOO LATE
          const remaining = activeItem.endTime - nowSeconds;
          log(`Too late to start ${activeItem.program_code} (${secondsPastStart}s > ${GRACE_PERIOD_SECONDS}s grace). Skipping.`);
          log(`Sleeping ${remaining}s until next slot.`);

          if (remaining > 0) await sleep(remaining * 1000);
          continue;
        }

        // ON TIME / GRACE (0 <= secondsPastStart <= 5)
        // Adjust duration
        // We want to stop exactly at endTime.
        // Total Time = endTime - nowSeconds.
        // Startup Overhead? 
        // If mpv takes 2s to start, we should stop 2s early? No.
        // We want to record content.
        // If we start 2s late (overhead), we miss 2s.
        // The file duration will be (Duration - Delay).
        // Filename should reflect *content* duration? Or *slot* duration?
        // User said: "subtract the seconds past slot start from the recording time so we don't record past the end".

        const idealDuration = activeItem.endTime - activeItem.secondsSinceMidnight;
        const remainingDuration = activeItem.endTime - nowSeconds;

        // Apply startup overhead correction?
        // "Include a configurable 1-2 second factor for the time it takes to start mpv."
        // If we say "record for X seconds", mpv runs for X.
        // If it takes 2s to boot, does counting start after boot? Yes, usually stream-dump counts data.
        // So if we have 58s left in slot, and we tell mpv to dump 58s, 
        // it might take 2s to boot, then dump 58s, ending 2s late!
        // So we must subtract STARTUP_OVERHEAD.

        let adjustDuration = remainingDuration - STARTUP_OVERHEAD_SECONDS;
        if (adjustDuration < 0) adjustDuration = 0;

        log(`Starting ${activeItem.program_code} (Delay: ${secondsPastStart}s). Duration adjusted: ${adjustDuration}s (Ideal: ${idealDuration}s)`);

        // Make directory
        const dParts = todayStr.split('-');
        const recDir = path.join(RECORD_BASE, dParts[0], dParts[1], dParts[2]);
        await fsp.mkdir(recDir, { recursive: true });

        // Filename: using ideal slot duration for consistency in naming
        const hour = String(Math.floor(activeItem.secondsSinceMidnight / 3600)).padStart(2, '0');
        const outFile = path.join(recDir, `${hour}-${activeItem.program_code || 'UNK'}-${idealDuration}.mp3`);
        const tempFile = outFile + '.tmp';

        // Start
        const p = startRecording(tempFile);

        // Overlap Handoff
        await sleep(2000); // 2s overlap?
        if (currentRecording) {
          const toFinalize = currentRecording;
          stopRecording(toFinalize.process).then(() => {
            // Rename temp to final
            try {
              if (fs.existsSync(toFinalize.tempFile)) {
                fs.renameSync(toFinalize.tempFile, toFinalize.outFile);
                log(`[Atomic] Finalized recording: ${path.basename(toFinalize.outFile)}`);
              }
            } catch (e) {
              log(`[Atomic] Error finalizing ${toFinalize.outFile}: ${e.message}`);
            }
            // Async analysis of the file we just finished
            // Only analyze if it finishes at the end of the hour
            if (toFinalize.endTime % 3600 === 0) {
              analyzeFileForDTMF(toFinalize.outFile, 60000).then(tones => {
                if (tones && tones.length > 0) {
                  // Guardrails: Only count the LAST #4 tone, and only if it's in the last minute
                  const relevantTones = tones.filter(t => t.digit === '#4' && t.fromEnd < 60);
                  const tone = relevantTones[relevantTones.length - 1];

                  if (tone) {
                    const drift = tone.fromEnd - 13;

                    // Guardrail: Never adjust the offset by more than 60 seconds
                    if (Math.abs(drift) > 60) {
                      log(`[Calibration] Ignoring large drift: ${drift.toFixed(2)}s. No adjustment made.`);
                      return;
                    }

                    let newOffset = STREAM_OFFSET_SECONDS + drift;

                    // Normalization: Ensure offset stays within [-1800, 1800] range.
                    // This "snaps" any hour-long jumps back to the correct hour.
                    newOffset = ((newOffset + 1800) % 3600);
                    if (newOffset < 0) newOffset += 3600;
                    newOffset = Math.round((newOffset - 1800) * 10) / 10;

                    log(`[Calibration] Detected #4 at ${tone.fromEnd}s from end. Drift: ${drift.toFixed(2)}s. Adjusting offset: ${STREAM_OFFSET_SECONDS} -> ${newOffset}`);
                    saveOffset(newOffset).catch(e => log('Calibration Save Error:', e));
                  }
                }
              }).catch(e => log('DTMF Error:', e));
            }
            // Async cleanup of duplicates
            cleanupProgramDuplicates(toFinalize.programCode, toFinalize.outFile).catch(e => log('Cleanup error:', e));
          });
        }

        currentRecording = {
          signature,
          programCode: activeItem.program_code,
          process: p,
          outFile,
          tempFile,
          endTime: activeItem.endTime
        };

        // Self-tuning sleep
        // We want to wake up exactly at next slot start.
        // But we passed `adjustDuration` to... wait, we didn't pass it to mpv.
        // We handle duration by SLEEPING here.

        // We are currently running `p`.
        // We need to sleep until `activeItem.endTime`.
        // But we subtract STARTUP_OVERHEAD_SECONDS?
        // If we want to be ready for NEXT slot exactly at 0s delay.
        // We should wake up slightly before?
        // No, the loop checks time.
        // If we wake up 1s early, loop sees -1s delay -> waits 1s -> Starts exactly at 0.
        // Perfect.

        // So we sleep `adjustDuration`. 
        // adjustDuration = remaining - 2s.
        // So we wake up 2s before end of slot.
        // Then loop runs, sees we are still in current slot?
        // Wait.
        // If we wake up 2s before end.
        // nowSeconds < endTime.
        // We find activeItem is CURRENT item.
        // signature matches.
        // We do nothing.
        // Loop sleeps 1s.

        // We NEED to ensure we trigger the NEXT start.
        // The overlap logic handles this?
        // "Always start recording the next item on time if possible."
        // To do that, we need to be in the loop processing the NEXT item at its start time.

        // Current logic:
        // 1. Start Rec A.
        // 2. Sleep loop small increments? 
        // 3. When time is Active Item B (next slot), we start B.
        // 4. Then we stop A.

        // Issue: If we just sleep huge amount, we might drift?
        // Better to sleep small increments or calculated wake up.

        // If we use sleep(adjustDuration), we wake up 2s before end.
        // Then we loop. 
        // We are still in Slot A.
        // We continue.
        // We loop until Time >= Slot B Start.
        // Then activeItem becomes B.
        // Then we start B.
        // Then we stop A.

        // This logic holds!
        // We just need to make sure we don't sleep PAST the start of B.

        log(`Recording running. Sleeping ${adjustDuration}s until near end of slot.`);
        await sleep(adjustDuration * 1000);

        // Now we are 2s before end.
        // We go back to top of loop.
        // Ensure loop doesn't sleep 1s and miss the boundary if precise?
        // 1s sleep is fine. 
        // "If we happen to be ready to record before slot start by a couple seconds, sleep until the exact starting time."
        // This is handled by the `secondsPastStart < 0` block.

      }

      // Background fetch logic
      // Every loop, check if we need to fetch tomorrow?
      // Only do it once. `ensureInBackground` handles dedup.
      // Do it if we are past noon.
      if (effectiveTime.getHours() >= 12) {
        const tmr = new Date(effectiveTime);
        tmr.setDate(tmr.getDate() + 1);
        scheduler.ensureInBackground(formatDate(tmr));
      }

      // Cleanup logic: Daily at 3 AM
      const currentDay = formatDate(effectiveTime);
      if (effectiveTime.getHours() === 3 && currentDay !== lastCleanupDay) {
        lastCleanupDay = currentDay;
        dailyLegacyCleanup().catch(e => log('Legacy cleanup error:', e));
      }

      // Sleep slightly
      await sleep(1000);

    } catch (e) {
      log('Main Loop Error:', e);
      await sleep(5000);
    }
  }
}

runLoop().catch(e => { console.error(e); process.exit(1); });

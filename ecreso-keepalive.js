import puppeteer from 'puppeteer';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

// ================= CONFIGURATION =================
const CONFIG = {
  IP: '192.168.2.206',
  USER: 'Admin',
  PASS: 'admin',
  SCREEN_NAME: 'Puppeteer',
  URL_PROTOCOL: 'https',
  RESTART_HOUR: 3, // 3 AM
  CHECK_INTERVAL_MS: 1000,
  PING_INTERVAL_MS: 60000,
  PING_TIMEOUT_SEC: 2
};

// ================= UTILS =================

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

// Cleanup puppeteer profiles from /tmp
async function cleanupProfiles() {
  log('Cleaning up temporary Puppeteer profiles...');
  try {
    const tmpDir = '/tmp';
    const files = await fs.promises.readdir(tmpDir);
    const profiles = files.filter(f => f.startsWith('puppeteer_dev_chrome_profile'));

    for (const p of profiles) {
      const fullPath = path.join(tmpDir, p);
      try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
      } catch (e) {
        // ignore locked files
      }
    }
    log(`Cleaned up ${profiles.length} profiles.`);
  } catch (e) {
    log('Error cleaning profiles:', e.message);
  }
}

// Ping check with state for logging
let lastPingSuccess = true; // Assume success initially to force log on first error
async function checkConnectivity() {
  try {
    await execPromise(`ping -c 1 -W ${CONFIG.PING_TIMEOUT_SEC} ${CONFIG.IP}`);
    if (!lastPingSuccess) {
      log(`Connectivity to ${CONFIG.IP} restored.`);
    }
    lastPingSuccess = true;
    return true;
  } catch (e) {
    if (lastPingSuccess) {
      log(`Error: Cannot reach ${CONFIG.IP}. Retrying...`);
    }
    lastPingSuccess = false;
    return false;
  }
}


// ================= BROWSER INTERACTION =================

async function getField(page, labelText) { // Get value of input after label
  try {
    const value = await page.evaluate((labelText) => {
      const label = Array.from(document.querySelectorAll('label'))
        .find(label => label.textContent.includes(labelText));
      if (!label || !label.getAttribute('for')) return null;
      const input = document.getElementById(label.getAttribute('for'));
      return input ? input.value : null;
    }, labelText);
    return value;
  } catch (e) {
    return null;
  }
}

async function shot(page, n) {
  log('Taking Screenshot #' + n);
  try {
    await page.screenshot({ type: "jpeg", path: "screenshot" + n + ".jpeg", fullPage: true, });
  } catch (e) { }
}

// Click first button matching text
async function clickButton(page, text) {
  try {
    await page.$$eval('button', (buttons, text) => {
      for (const button of buttons) {
        if (button.textContent === text) {
          button.click();
          break; // Clicking the first matching button and exiting the loop
        }
      }
    }, text);
  } catch (e) { }
}

// Main Browser Session
async function runBrowserSession() {
  log('Launching browser session...');
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      ignoreHTTPSErrors: true,
      args: [
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage' // Helps with memory in containers/limited envs
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    const targetUrl = `${CONFIG.URL_PROTOCOL}://${CONFIG.IP}`;
    log(`Navigating to ${targetUrl}...`);

    await page.goto(targetUrl, {
      waitUntil: ["load", "domcontentloaded"],
      timeout: 30000
    });

    log('Waiting for login page...');
    // Wait for login elements
    await page.waitForSelector('#x-auto-26-input', { timeout: 10000 });	// User
    await page.waitForSelector('#x-auto-27-input', { timeout: 10000 });	// Password
    await page.waitForSelector('#x-auto-28-input', { timeout: 10000 });	// Screen Name

    // Fill form
    await page.type('#x-auto-26-input', CONFIG.USER);
    await page.type('#x-auto-27-input', CONFIG.PASS);
    await page.type('#x-auto-28-input', CONFIG.SCREEN_NAME);

    // Submit form
    log('Logging in...');
    await page.keyboard.press('Enter');
    await delay(5000); // Increased wait for login transition

    // Select Transmitter page
    log('Selecting Transmitter page...');
    try {
      await clickButton(page, 'Transmitter');
    } catch (e) {
      // Retry once if button not found immediately?
      await delay(2000);
      await clickButton(page, 'Transmitter');
    }
    await delay(5000);

    let old = 0;
    let failnum = 0;

    // Calculate next restart time (Next 3 AM)
    const now = new Date();
    let nextRestart = new Date(now);
    nextRestart.setHours(CONFIG.RESTART_HOUR, 0, 0, 0);
    if (now >= nextRestart) {
      // If already past 3 AM today, schedule for tomorrow
      nextRestart.setDate(nextRestart.getDate() + 1);
    }
    log(`Session started. Scheduled restart at ${nextRestart.toISOString()}`);

    while (true) {
      // Check for daily restart
      if (Date.now() >= nextRestart.getTime()) {
        log('Daily restart time reached. restarting browser...');
        break;
      }

      let power = await getField(page, 'Forward power (W):');

      // Handle page disconnect/error checks
      if (power === null) {
        throw new Error("Lost connection to page elements (power field null).");
      }

      if (old != power) {
        log(`Forward Power=${power}`);
        //process.stdout.write(`\rForward Power=${power}     \r`);
        // For service logs, maybe just log significant changes or periodically?
        // Keeping stdout write for interactive/journalctl -f
      }

      if (parseInt(power) == 0) {
        log('\nTransmitter power 0 detected! Restarting transmitter...');
        await shot(page, ++failnum);
        await clickButton(page, 'Disable');
        await delay(1000);
        await clickButton(page, 'Enable');
        // Wait 10s for power to come back
        await delay(10000);
      }

      await delay(CONFIG.CHECK_INTERVAL_MS);
      old = power;
    }

  } catch (e) {
    log('Browser session error:', e.message);
    throw e; // Propagate to trigger retry loop
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { }
    }
  }
}

// ================= MAIN LOOP =================

async function mainServiceLoop() {
  log('Starting Ecreso Keepalive Service...');

  while (true) {
    try {
      // 1. Cleanup
      await cleanupProfiles();

      // 2. Ping Check Loop
      // log('Checking connectivity...');
      while (true) {
        const online = await checkConnectivity();
        if (online) break;
        await delay(CONFIG.PING_INTERVAL_MS);
      }

      // 3. Run Browser Session
      await runBrowserSession();

    } catch (e) {
      // If browser session throws (error), we catch here
      // log('Service loop error (restarting in 1s)...');
      await delay(1000);
    }
  }
}

mainServiceLoop();

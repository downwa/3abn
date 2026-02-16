import puppeteer from 'puppeteer';

async function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function timeToIso(today, timeText) {
  const m = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!m) return `${today}T00:00:00`;
  let [, hStr, mStr, ap] = m;
  let h = parseInt(hStr, 10);
  const mm = parseInt(mStr, 10);
  ap = ap.toLowerCase();
  if (ap === 'am' && h === 12) h = 0;
  if (ap === 'pm' && h !== 12) h += 12;
  const hh = String(h).padStart(2, '0');
  const mm2 = String(mm).padStart(2, '0');
  return `${today}T${hh}:${mm2}:00`;
}

async function fetchScheduleOnce() {
  console.log('Fetching 3ABN schedule with expanded details...');

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

    await page.goto('https://r.3abn.org/sched-app/#/', {
      waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
      timeout: 60000,
    });

    await delay(3000); // Let Vue fully render

    // Expand ALL entries to get full details
    await page.evaluate(() => {
      document.querySelectorAll('.material-icons').forEach(icon => {
        if (icon.textContent.trim() === 'expand_more') {
          icon.click();
        }
      });
    });
    await delay(2000); // Wait for expansions

    const rawItems = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll('.sched-app-daily-entry'));
      
      return entries.map(entry => {
        // Image for series_img and program_code
        const imgEl = entry.querySelector('.sched-app-daily-entry-img');
        let seriesImg = imgEl ? imgEl.src : '';
        let programCodeFromImg = '';
        if (seriesImg) {
          const m = seriesImg.match(/\/([^\/]+)\.(jpg|png|jpeg|gif)$/i);
          if (m) programCodeFromImg = m[1];
        }

        // Compact title (series name)
        const titleEl = entry.querySelector('.sched-app-daily-entry-title');
        const seriesTitle = titleEl ? titleEl.textContent.trim() : '';

        // Time
        const timeEl = entry.querySelector('.sched-app-daily-entry-time');
        const timeText = timeEl ? timeEl.textContent.trim() : '';

        // Expanded details - look for structured fields
        const detailsSpan = entry.querySelector('.schedAppDailyEntryFull');
        let programTitle = '';
        let programCode = programCodeFromImg;
        let guest = '';

        if (detailsSpan) {
          // Extract Program Title: "Through The Valley"
          const progTitleMatch = detailsSpan.innerHTML.match(/<strong>Program Title:<\/strong>\s*(.*?)(?=<div|<strong|$)/i);
          if (progTitleMatch) {
            programTitle = progTitleMatch[1].trim().replace(/<\/?[^>]+(>|$)/g, "");
          }

          // Extract Program Code: "MIM250011" (overrides img-derived code)
          const progCodeMatch = detailsSpan.innerHTML.match(/<strong>Program Code:<\/strong>\s*([A-Z0-9]+)/i);
          if (progCodeMatch) {
            programCode = progCodeMatch[1];
          }

          // Extract Host: "Greg Morikone, Jill Morikone"
          const hostMatch = detailsSpan.innerHTML.match(/<strong>Host:<\/strong>\s*(.*?)(?=<div|<strong|$)/i);
          if (hostMatch) {
            guest = hostMatch[1].trim().replace(/<\/?[^>]+(>|$)/g, "");
          }
        }

        // Fallback: generate program_title from series + date if empty
        const today = new Date().toISOString().slice(0, 10);
        if (!programTitle) {
          programTitle = `${seriesTitle || 'Program'} on ${today}`;
        }

        return {
          series_title: seriesTitle,
          program_title: programTitle,
          program_code: programCode,
          series_img: seriesImg,
          timeText,
          guest,
        };
      }).filter(item => item.timeText); // Only valid time entries
    });

    const today = new Date().toISOString().slice(0, 10);
    const schedule = rawItems.map(item => ({
      series_title: item.series_title || '',
      program_title: item.program_title || '',
      program_code: item.program_code || '',
      series_img: item.series_img || '',
      date: timeToIso(today, item.timeText),
      guest: item.guest || '',
    }));

    const result = { schedule };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

fetchScheduleOnce().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


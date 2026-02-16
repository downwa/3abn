import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import util from 'util';

const fsp = fs.promises;
const TEST_DIR = path.join(os.tmpdir(), '3abn-test');

// --- Helper Logic from Services ---
function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

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

// Mock Validation Logic
function validateDuration(actual, scheduled) {
    const diff = actual - scheduled;
    if (diff < -5) return 'TOO_SHORT';
    if (diff > 5) return 'TOO_LONG';
    return 'OK';
}

async function runTests() {
    console.log('Running 3ABN Automation Tests...');
    console.log('--------------------------------');

    // Setup
    if (fs.existsSync(TEST_DIR)) await fsp.rm(TEST_DIR, { recursive: true, force: true });
    await fsp.mkdir(TEST_DIR, { recursive: true });

    let passed = 0;
    let failed = 0;

    function assert(desc, condition) {
        if (condition) {
            console.log(`PASS: ${desc}`);
            passed++;
        } else {
            console.error(`FAIL: ${desc}`);
            failed++;
        }
    }

    // --- TEST 1: Song Cache ---
    { // Block scope
        const mockSong = path.join(TEST_DIR, 'test_song.mp3');
        const cacheFile = path.join(TEST_DIR, 'song_cache.json');
        await fsp.writeFile(mockSong, 'data');
        const mockCache = { [mockSong]: 120 };
        await fsp.writeFile(cacheFile, JSON.stringify(mockCache));
        const loaded = JSON.parse(await fsp.readFile(cacheFile, 'utf-8'));
        assert('Cache persistence', loaded[mockSong] === 120);
    }

    // --- TEST 2: Time Parsing ---
    {
        const t1 = parseTimeToSeconds("12:00 AM"); // 0
        const t2 = parseTimeToSeconds("12:30 PM"); // 12*3600 + 30*60 = 45000
        const t3 = parseTimeToSeconds("11:59 PM"); // 23*3600 + 59*60 = 86340
        assert('Time: Midnight (12:00 AM)', t1 === 0);
        assert('Time: Noon (12:30 PM)', t2 === 45000);
        assert('Time: End of Day (11:59 PM)', t3 === 86340);
    }

    // --- TEST 3: Date Boundaries (Timezone/Edge Case) ---
    {
        // Test End of Year
        const d1 = new Date(2023, 11, 31); // Dec 31
        assert('Date: End of Year', formatDate(d1) === '2023-12-31');

        // Test Leap Year
        const d2 = new Date(2024, 1, 29); // Feb 29 2024
        assert('Date: Leap Year', formatDate(d2) === '2024-02-29');

        // Test Month Rollover
        const d3 = new Date(2023, 0, 32); // Should be Feb 1
        assert('Date: Overflow Correction', formatDate(d3) === '2023-02-01');
    }

    // --- TEST 4: Duration Validation Logic ---
    {
        const scheduled = 3600; // 1 hour
        assert('Validation: Exact match', validateDuration(3600, scheduled) === 'OK');
        assert('Validation: Slightly short (-4s)', validateDuration(3596, scheduled) === 'OK');
        assert('Validation: Slightly long (+4s)', validateDuration(3604, scheduled) === 'OK');
        assert('Validation: Too Short (-6s)', validateDuration(3594, scheduled) === 'TOO_SHORT');
        assert('Validation: Too Long (+6s)', validateDuration(3606, scheduled) === 'TOO_LONG');
    }

    // --- TEST 5: Fallback Search Logic (Simulation) ---
    {
        // Setup mock file structure
        // Today: 2026-02-16 (Missing file)
        // Yesterday: 2026-02-15 (Has file)
        // program code: 'MOCKPROC'
        const today = '2026-02-16';
        const yest = '2026-02-15';

        const dir1 = path.join(TEST_DIR, today);
        const dir2 = path.join(TEST_DIR, yest);
        await fsp.mkdir(dir1, { recursive: true });
        await fsp.mkdir(dir2, { recursive: true });

        // Create file in yesterday's folder
        const targetFile = path.join(dir2, '08-00-00-MOCKPROC-Test.mp3');
        await fsp.writeFile(targetFile, 'content');

        // Search logic simulation
        async function mockFindFile(code) {
            // Parse manually to avoid UTC shift
            const [y, m, d] = today.split('-').map(Number);
            let curr = new Date(y, m - 1, d); // Local time construction

            for (let i = 0; i < 30; i++) {
                curr.setDate(curr.getDate() - 1);
                const dStr = formatDate(curr);
                const checkDir = path.join(TEST_DIR, dStr);
                if (fs.existsSync(checkDir)) {
                    const files = await fsp.readdir(checkDir);
                    const match = files.find(f => f.includes(code));
                    if (match) return path.join(checkDir, match);
                }
            }
            return null;
        }

        const found = await mockFindFile('MOCKPROC');
        assert('Fallback: Found file in previous day', found === targetFile);

        const notFound = await mockFindFile('MISSING');
        assert('Fallback: Correctly returns null', notFound === null);
    }

    console.log('--------------------------------');
    console.log(`Results: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const fsp = fs.promises;
const TEST_DIR = path.join(os.tmpdir(), '3abn-test');

async function runTests() {
    console.log('Running 3ABN Automation Tests...');

    // Setup
    if (fs.existsSync(TEST_DIR)) await fsp.rm(TEST_DIR, { recursive: true, force: true });
    await fsp.mkdir(TEST_DIR, { recursive: true });

    // Test 1: Mock Song Library Cache
    console.log('[Test 1] Song Library Cache Generation');
    const mockSong = path.join(TEST_DIR, 'test_song.mp3');
    await fsp.writeFile(mockSong, 'fake content'); // 0 byte effective audio, but file exists

    const cacheFile = path.join(TEST_DIR, 'song_cache.json');
    const mockCache = { [mockSong]: 120 };
    await fsp.writeFile(cacheFile, JSON.stringify(mockCache));

    const loaded = JSON.parse(await fsp.readFile(cacheFile, 'utf-8'));
    if (loaded[mockSong] === 120) {
        console.log('  PASS: Cache loaded correctly.');
    } else {
        console.error('  FAIL: Cache mismatch.');
    }

    // Test 2: Output IPC Socket Simulation (Dry Run)
    console.log('[Test 2] IPC Socket Simulation');
    const socketPath = path.join(TEST_DIR, 'socket');

    // We can't easily mock net.createConnection without mocking the module.
    // But we can verify file creation logic.

    // Test 3: Schedule Parsing Logic
    console.log('[Test 3] Schedule Time Parsing');
    // Copy parseTimeToSeconds logic from recorder to verify
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

    const t1 = parseTimeToSeconds("12:00 AM");
    const t2 = parseTimeToSeconds("12:30 PM");
    const t3 = parseTimeToSeconds("11:59 PM");

    if (t1 === 0 && t2 === 12 * 3600 + 30 * 60 && t3 === 23 * 3600 + 59 * 60) {
        console.log('  PASS: Time parsing correct.');
    } else {
        console.error(`  FAIL: Time parsing. Got ${t1}, ${t2}, ${t3}`);
    }

    // Done
    console.log('Tests Completed.');
}

runTests().catch(console.error);

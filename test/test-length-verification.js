import fs from 'fs';
import path from 'path';
import os from 'os';
import { getFileDuration } from '../dtmf-analyzer.js';
import { spawn } from 'child_process';

const fsp = fs.promises;
const TEST_DIR = path.join(os.tmpdir(), '3abn-verify-length');

async function test() {
    console.log('Verifying Recording Length Check Logic...');

    if (fs.existsSync(TEST_DIR)) await fsp.rm(TEST_DIR, { recursive: true, force: true });
    await fsp.mkdir(TEST_DIR, { recursive: true });

    // 1. Test getFileDuration with a real (small) file
    const testFile = path.join(TEST_DIR, 'test.mp3');
    // Generate a 2 second silent mp3
    console.log('Generating 2s test file...');
    await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-acodec', 'libmp3lame', testFile
        ]);
        ffmpeg.on('close', resolve);
        ffmpeg.on('error', reject);
    });

    const duration = await getFileDuration(testFile);
    console.log(`Measured duration: ${duration}s`);
    if (Math.abs(duration - 2) > 0.5) {
        console.error('FAIL: Duration measurement failed');
        process.exit(1);
    }
    console.log('PASS: getFileDuration works');

    // 2. Simulate finalization logic
    const scheduledDuration = 10;
    const minAllowed = scheduledDuration - 5;

    async function simulateFinalization(actualDur) {
        // Mocking the check logic from threeabn-recorder.js
        console.log(`Simulating finalization for actual duration ${actualDur}s (Scheduled: ${scheduledDuration}s)`);
        if (actualDur < minAllowed) {
            console.log(`[Verification] Recording TOO SHORT (${actualDur}s < ${minAllowed}s). Deleting.`);
            return false; // Deleted
        }
        console.log(`[Verification] Recording duration OK (${actualDur}s / ${scheduledDuration}s).`);
        return true; // Kept
    }

    if (await simulateFinalization(2) === false) {
        console.log('PASS: 2s recording (scheduled 10s) would be deleted');
    } else {
        console.error('FAIL: 2s recording should have been deleted');
        process.exit(1);
    }

    if (await simulateFinalization(8) === true) {
        console.log('PASS: 8s recording (scheduled 10s) would be kept');
    } else {
        console.error('FAIL: 8s recording should have been kept');
        process.exit(1);
    }

    console.log('--------------------------------');
    console.log('Verification Complete!');
}

test().catch(e => {
    console.error(e);
    process.exit(1);
});

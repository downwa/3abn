import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import DtmfDetectionStream from 'dtmf-detection-stream';

const execPromise = promisify(exec);

function log(...args) {
    console.log(new Date().toISOString(), '-', ...args);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function getFileDuration(filePath) {
    try {
        const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        const dur = parseFloat(stdout.trim());
        return isNaN(dur) ? 0 : dur;
    } catch (e) {
        return 0;
    }
}

/**
 * Analyzes a recorded file for DTMF tones.
 * @param {string} filePath - Absolute path to the file.
 * @param {number} delayMs - Optional delay before starting analysis (default 0).
 */
export async function analyzeFileForDTMF(filePath, delayMs = 0) {
    if (!fs.existsSync(filePath)) {
        log(`[DTMF] Error: File not found: ${filePath}`);
        return;
    }

    if (delayMs > 0) {
        log(`[DTMF] Scheduling analysis for ${path.basename(filePath)} in ${delayMs / 1000}s...`);
        await sleep(delayMs);
    }

    // Get duration first
    const duration = await getFileDuration(filePath);
    log(`[DTMF] Starting analysis of ${path.basename(filePath)} (Duration: ${duration.toFixed(2)}s)...`);

    return new Promise((resolve) => {
        const format = {
            sampleRate: 8000,
            bitDepth: 16,
            channels: 1,
        };

        const dds = new DtmfDetectionStream({ format });
        let tonesFound = [];
        let lastDigit = null;
        let lastTimestamp = 0;

        dds.on('dtmf', data => {
            const timeDiff = data.timestamp - lastTimestamp;
            if (lastDigit === '#' && data.digit === '4' && timeDiff <= 0.2) {
                const fromEnd = duration ? (duration - lastTimestamp).toFixed(3) : 'unknown';
                log(`[DTMF] ${path.basename(filePath)}: Detected "#4" at ${lastTimestamp.toFixed(3)}s (${fromEnd}s from end)`);
                tonesFound.push({ digit: '#4', timestamp: lastTimestamp, fromEnd: parseFloat(fromEnd) });
            }
            lastDigit = data.digit;
            lastTimestamp = data.timestamp;
        });

        const ffmpeg = spawn('ffmpeg', [
            '-i', filePath,
            '-f', 's16le',
            '-ar', '8000',
            '-ac', '1',
            'pipe:1'
        ]);

        ffmpeg.stdout.on('data', (data) => {
            if (dds.writable) dds.write(data);
        });

        ffmpeg.on('close', (code) => {
            if (tonesFound.length === 0) {
                log(`[DTMF] ${path.basename(filePath)}: No tones found.`);
            } else {
                log(`[DTMF] ${path.basename(filePath)}: Analysis complete. Found ${tonesFound.length} digits.`);
            }
            resolve(tonesFound);
        });

        ffmpeg.stderr.on('data', () => { /* ignore ffmpeg noise */ });
    });
}

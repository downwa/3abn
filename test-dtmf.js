#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { analyzeFileForDTMF } from './dtmf-analyzer.js';

const RECORD_BASE = path.join(os.homedir(), '0Radio', '3abn');

async function recursiveList(dir) {
    let results = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of list) {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(await recursiveList(res));
            } else if (entry.name.endsWith('.mp3')) {
                results.push(res);
            }
        }
    } catch (e) { }
    return results;
}

async function main() {
    let fileToAnalyze = process.argv[2];

    if (fileToAnalyze) {
        if (!fs.existsSync(fileToAnalyze)) {
            console.error(`Error: File not found: ${fileToAnalyze}`);
            process.exit(1);
        }
        fileToAnalyze = path.resolve(fileToAnalyze);
    } else {
        console.log('No file specified, searching for latest recording in:', RECORD_BASE);
        const files = await recursiveList(RECORD_BASE);

        if (files.length === 0) {
            console.log('No mp3 files found.');
            return;
        }

        // Sort by mtime
        const stats = await Promise.all(files.map(async f => ({ path: f, mtime: (await fs.promises.stat(f)).mtimeMs })));
        stats.sort((a, b) => b.mtime - a.mtime);

        fileToAnalyze = stats[0].path;
        console.log('Found latest file:', path.basename(fileToAnalyze));
    }

    await analyzeFileForDTMF(fileToAnalyze, 0);
    console.log('Done.');
}

main().catch(err => console.error(err));

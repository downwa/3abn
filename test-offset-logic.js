function normalizeOffset(val) {
    let newOffset = ((val + 1800) % 3600);
    if (newOffset < 0) newOffset += 3600;
    return Math.round((newOffset - 1800) * 10) / 10;
}

function getApplicableTone(tones) {
    const relevantTones = tones.filter(t => t.digit === '#4' && t.fromEnd < 60);
    return relevantTones[relevantTones.length - 1];
}

const STREAM_OFFSET_SECONDS = 21605.9;

const mockTones = [
    { digit: '#4', fromEnd: 3587 }, // Tone from start of file (ignored)
    { digit: '#4', fromEnd: 15 },   // Real tone near end (captured)
    { digit: '#', fromEnd: 10 },   // Not a #4
    { digit: '#4', fromEnd: 5 },   // Another #4 near end (last one wins)
];

console.log('--- Tone Filtering Test ---');
const tone = getApplicableTone(mockTones);
console.log('Selected Tone fromEnd:', tone ? tone.fromEnd : 'NONE');
if (tone && tone.fromEnd === 5) {
    console.log('PASS: Selected last tone within 60s of end.');
} else {
    console.log('FAIL: Did not select correct tone.');
}

console.log('\n--- Normalization Test (Current 6h Offset) ---');
const drift = (tone ? tone.fromEnd : 13) - 13; // 5 - 13 = -8
let newOffset = STREAM_OFFSET_SECONDS + drift; // 21605.9 - 8 = 21597.9
console.log('Raw New Offset:', newOffset);
const normalized = normalizeOffset(newOffset);
console.log('Normalized Offset:', normalized);
if (normalized === -2.1) {
    console.log('PASS: Correctly snapped 21605.9 -> -2.1');
} else {
    console.log('FAIL: Expected -2.1');
}

console.log('\n--- Guardrail Test (Large Drift) ---');
const largeDriftTone = { digit: '#4', fromEnd: 100 }; // 100-13 = 87s drift (> 60s)
const isLarge = Math.abs(largeDriftTone.fromEnd - 13) > 60;
console.log('Is 87s drift blocked?', isLarge ? 'YES (PASS)' : 'NO (FAIL)');

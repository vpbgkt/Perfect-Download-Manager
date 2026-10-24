// Extract ASCII and UTF-16LE strings (min length 4) and print those matching a regex, with file offsets.
// Usage: node strgrep.mjs <file> <regex> [maxResults]
import { readFileSync } from 'node:fs';

const b = readFileSync(process.argv[2]);
const re = new RegExp(process.argv[3], 'i');
const max = Number(process.argv[4] ?? 400);
const out = [];
const printable = (c) => c >= 0x20 && c < 0x7f;

let start = -1;
for (let i = 0; i <= b.length; i++) {
  if (i < b.length && printable(b[i])) { if (start < 0) start = i; continue; }
  if (start >= 0 && i - start >= 4) out.push([start, 'A', b.toString('latin1', start, i)]);
  start = -1;
}
start = -1;
for (let i = 0; i + 1 <= b.length; i += 2) {
  const ok = i + 1 < b.length && printable(b[i]) && b[i + 1] === 0;
  if (ok) { if (start < 0) start = i; continue; }
  if (start >= 0 && (i - start) / 2 >= 4) out.push([start, 'W', b.toString('utf16le', start, i)]);
  start = -1;
}
// Odd-aligned UTF-16 as well
start = -1;
for (let i = 1; i + 1 <= b.length; i += 2) {
  const ok = i + 1 < b.length && printable(b[i]) && b[i + 1] === 0;
  if (ok) { if (start < 0) start = i; continue; }
  if (start >= 0 && (i - start) / 2 >= 4) out.push([start, 'W', b.toString('utf16le', start, i)]);
  start = -1;
}
out.sort((a, c) => a[0] - c[0]);
let n = 0;
for (const [off, kind, s] of out) {
  if (!re.test(s)) continue;
  console.log(`0x${off.toString(16).padStart(7, '0')} ${kind} ${s.length > 200 ? s.slice(0, 200) + '…' : s}`);
  if (++n >= max) break;
}
console.error(`${n} matches`);

// Minimal PE triage: sections (+entropy) and import table. Usage: node petriage.mjs <file> [dllFilterRegex]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const b = readFileSync(file);
const pe = b.readUInt32LE(0x3c);
if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('not PE');
const machine = b.readUInt16LE(pe + 4);
const nsec = b.readUInt16LE(pe + 6);
const optSize = b.readUInt16LE(pe + 20);
const opt = pe + 24;
const magic = b.readUInt16LE(opt);
const is64 = magic === 0x20b;
const ddBase = opt + (is64 ? 112 : 96);
const secBase = opt + optSize;
const secs = [];
for (let i = 0; i < nsec; i++) {
  const o = secBase + i * 40;
  const name = b.toString('ascii', o, o + 8).replace(/\0+$/, '');
  const vsize = b.readUInt32LE(o + 8), va = b.readUInt32LE(o + 12), rsize = b.readUInt32LE(o + 16), rptr = b.readUInt32LE(o + 20);
  const data = b.subarray(rptr, rptr + rsize);
  const freq = new Array(256).fill(0); for (const x of data) freq[x]++;
  let ent = 0; for (const f of freq) if (f) { const p = f / data.length; ent -= p * Math.log2(p); }
  secs.push({ name, va, vsize, rptr, rsize, ent });
}
const rva2off = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return rva - s.va + s.rptr; return -1; };
const cstr = (off) => { let e = off; while (b[e]) e++; return b.toString('ascii', off, e); };
console.log(`machine=0x${machine.toString(16)} ${is64 ? 'PE32+' : 'PE32'} sections=${nsec}`);
for (const s of secs) console.log(`  ${s.name.padEnd(8)} va=0x${s.va.toString(16)} vsize=${s.vsize} rsize=${s.rsize} entropy=${s.ent.toFixed(2)}`);
const impRva = b.readUInt32LE(ddBase + 8);
let off = rva2off(impRva);
const imports = {};
while (off > 0) {
  const oft = b.readUInt32LE(off), nameRva = b.readUInt32LE(off + 12), ft = b.readUInt32LE(off + 16);
  if (!nameRva) break;
  const dll = cstr(rva2off(nameRva));
  const fns = [];
  let t = rva2off(oft || ft);
  while (t > 0) {
    const v = is64 ? b.readBigUInt64LE(t) : BigInt(b.readUInt32LE(t));
    if (v === 0n) break;
    const ord = is64 ? (v >> 63n) : (v >> 31n);
    if (ord) fns.push('#' + (v & 0xffffn)); else fns.push(cstr(rva2off(Number(v & 0x7fffffffn)) + 2));
    t += is64 ? 8 : 4;
  }
  imports[dll] = fns;
  off += 20;
}
for (const [dll, fns] of Object.entries(imports)) {
  if (filter && !filter.test(dll)) { console.log(`${dll}: ${fns.length} imports`); continue; }
  console.log(`${dll} (${fns.length}): ${fns.join(', ')}`);
}

// Delay-load imports (data directory 13). Descriptor: attrs, name, hmod, IAT, INT, boundIAT, unloadIAT, timestamp.
const dRva = b.readUInt32LE(ddBase + 13 * 8);
let doff = dRva ? rva2off(dRva) : -1;
while (doff > 0) {
  const attrs = b.readUInt32LE(doff), nameR = b.readUInt32LE(doff + 4), intR = b.readUInt32LE(doff + 16);
  if (!nameR) break;
  const base = (attrs & 1) ? 0 : (is64 ? Number(b.readBigUInt64LE(opt + 24)) : b.readUInt32LE(opt + 28));
  const dll = cstr(rva2off(nameR - base));
  const fns = [];
  let t = rva2off(intR - base);
  while (t > 0) {
    const v = is64 ? Number(b.readBigUInt64LE(t) & 0x7fffffffffffffffn) : b.readUInt32LE(t);
    if (!v) break;
    const isOrd = is64 ? (b.readBigUInt64LE(t) >> 63n) === 1n : (v >>> 31) === 1;
    fns.push(isOrd ? '#' + (v & 0xffff) : cstr(rva2off(v - base) + 2));
    t += is64 ? 8 : 4;
  }
  console.log(`[delay] ${dll} (${fns.length}): ${fns.join(', ')}`);
  doff += 32;
}

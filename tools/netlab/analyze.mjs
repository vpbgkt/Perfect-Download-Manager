// Summarises a labserver JSONL log: throughput timeline, concurrency, tail behaviour, range pattern.
// Usage: node analyze.mjs <log.jsonl> [--ranges N] [--timeline]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const showRanges = Number(process.argv.includes('--ranges') ? process.argv[process.argv.indexOf('--ranges') + 1] : 0);
const showTimeline = process.argv.includes('--timeline');
const ev = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const reqs = new Map();
for (const e of ev) {
  if (e.ev === 'req') reqs.set(e.rid, { ...e });
  if (e.ev === 'done' && reqs.has(e.rid)) Object.assign(reqs.get(e.rid), { sent: e.sent, aborted: e.aborted, ms: e.ms, tEnd: e.t });
}
const ticks = ev.filter((e) => e.ev === 'tick');
const opens = ev.filter((e) => e.ev === 'open');
const all = [...reqs.values()];
const data = all.filter((r) => r.method === 'GET' && r.sent > 0);
const tStart = Math.min(...all.map((r) => r.t));
const tLast = Math.max(...data.map((r) => r.tEnd));
const total = ticks.length ? ticks[ticks.length - 1].total : data.reduce((s, r) => s + r.sent, 0);
const size = Math.max(...all.filter((r) => r.end != null).map((r) => r.end + 1));
const MB = 1024 * 1024;

// Cumulative bytes over time from 250 ms ticks.
const cum = ticks.map((t) => ({ t: t.t, total: t.total, bps: t.bps, responses: t.responses, sockets: t.sockets }));
const timeAt = (frac) => { const x = cum.find((c) => c.total >= frac * size); return x ? x.t - tStart : NaN; };
const t50 = timeAt(0.5), t90 = timeAt(0.9), t99 = timeAt(0.99), t100 = tLast - tStart;

// 1 s throughput buckets.
const buckets = [];
for (const c of cum) { const k = Math.floor(c.t - tStart); buckets[k] = (buckets[k] ?? 0) + c.bps / 4; }
const steady = buckets.slice(3, Math.floor(t90)).filter((x) => x != null);
const mean = steady.reduce((a, b) => a + b, 0) / Math.max(1, steady.length);
const sd = Math.sqrt(steady.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, steady.length));
const minSteady = steady.length ? Math.min(...steady) : 0;
const avgConc = (() => { const w = cum.filter((c) => c.t - tStart < t90); return w.reduce((a, c) => a + c.responses, 0) / Math.max(1, w.length); })();
const maxConc = Math.max(...cum.map((c) => c.responses));

const fmt = (x) => (x / MB).toFixed(2);
console.log(`file=${file}`);
const rejects = ev.filter((e) => e.ev === 'reject').length;
console.log(`rejectedForeignRequests=${rejects}`);
console.log(`size=${fmt(size)} MiB served=${fmt(total)} MiB (overhead ${(100 * (total - size) / size).toFixed(2)}%)  sockets=${opens.length} requests=${all.length} aborted=${all.filter((r) => r.aborted).length}`);
console.log(`time: total=${t100.toFixed(2)}s  50%=${t50.toFixed(2)}s  90%=${t90.toFixed(2)}s  99%=${t99.toFixed(2)}s  tail(90->100%)=${(t100 - t90).toFixed(2)}s`);
console.log(`speed: overall=${fmt(size / t100)} MiB/s  0-90%=${fmt(0.9 * size / t90)} MiB/s  last10%=${fmt(0.1 * size / (t100 - t90))} MiB/s  last1%=${fmt(0.01 * size / (t100 - t99))} MiB/s`);
console.log(`steady(3s..90%): mean=${fmt(mean)} MiB/s  cv=${(100 * sd / mean).toFixed(1)}%  min1s=${fmt(minSteady)} MiB/s  avgConcurrentResponses=${avgConc.toFixed(1)} max=${maxConc}`);
if (showTimeline) {
  console.log('per-second MiB/s [concurrent responses @ end of second]:');
  const conc = []; for (const c of cum) conc[Math.floor(c.t - tStart)] = c.responses;
  console.log(buckets.map((b, i) => `${i}:${fmt(b ?? 0)}[${conc[i] ?? 0}]`).join(' '));
}
if (showRanges) {
  console.log('requests (t, sock, first, range, sent MiB, aborted, ms):');
  for (const r of all.slice(0, showRanges)) {
    console.log(`  ${(r.t - tStart).toFixed(2).padStart(6)}s s${String(r.sock).padEnd(3)} ${r.first ? 'new ' : 'reuse'} ${r.method} ${String(r.range).padEnd(28)} ${r.sent != null ? fmt(r.sent).padStart(7) : '      ?'} ${r.aborted ? 'ABORT' : '     '} ${r.ms ?? ''}`);
  }
}

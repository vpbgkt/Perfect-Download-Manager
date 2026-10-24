// Instrumented HTTP/1.1 range server that emulates a WAN link, for black-box comparison of download
// managers. Every request and connection is logged (JSONL) together with a 250 ms aggregate timeline.
//
// Content is deterministic per absolute offset: byte(o) = BLOCK[o mod 1 MiB] ^ (floor(o / 1 MiB) & 0xFF),
// so any range can be produced on the fly and a finished download can be verified byte-for-byte.
// See docs/DOWNLOAD-ENGINE-PERFORMANCE.md for the scenarios used to compare PDM with IDM.
//
// Link model:
//   --link      shared line capacity (bytes/s) across all connections (virtual-time FIFO scheduler)
//   --perconn   per-connection ceiling (bytes/s), e.g. TCP window/RTT-bound or server per-conn throttle
//   --ramp      seconds for a new connection to ramp from 10% to its full per-connection rate (slow start)
//   --connlat   extra delay (ms) before the first response on a new TCP connection (TCP+TLS handshakes)
//   --reqlat    delay (ms) before every response (request RTT + server think time)
//   --slowevery make every Nth connection degraded (0 = never); --slowrate its ceiling (bytes/s)
//   --jitter    per-connection rate noise (0..1), re-drawn every 500 ms (cross traffic / TCP sawtooth)
//   --stallevery every Nth connection silently stops sending after --stallafter bytes (socket kept open)
//   --maxconns  per-client limit: a request arriving while this many responses are open gets 429, as many
//               file hosts and speed-test mirrors do (0 = unlimited)
//
// Only http://127.0.0.1:<port>/<path> is served (--path, default lab.bin); use a fresh path per run so a
// client still retrying an earlier run is rejected (404, logged) instead of skewing the measurement.
//
// Usage:
//   node labserver.mjs --port 8765 --path run1.bin --size 629145600 --link 20971520 --perconn 3145728 --log run1.jsonl
//   node labserver.mjs --size 629145600 --verify <downloaded file>     (byte-for-byte check, then exit)
//   node analyze.mjs run1.jsonl --timeline --ranges 40
import http from 'node:http';
import { createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

// The last occurrence of a flag wins, so a scenario can override a base setting (e.g. --perconn).
const arg = (name, def) => {
  const i = process.argv.lastIndexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', 8765));
const SIZE = Number(arg('size', 600 * 1024 * 1024));
const LINK = Number(arg('link', 20 * 1024 * 1024));
const PERCONN = Number(arg('perconn', 3 * 1024 * 1024));
const RAMP = Number(arg('ramp', 1.0));
const CONNLAT = Number(arg('connlat', 150));
const REQLAT = Number(arg('reqlat', 50));
const SLOWEVERY = Number(arg('slowevery', 0));
const SLOWRATE = Number(arg('slowrate', 64 * 1024));
const JITTER = Number(arg('jitter', 0));        // per-connection rate re-drawn every 500 ms in [1-j, 1+j]
const STALLEVERY = Number(arg('stallevery', 0)); // every Nth connection stops sending (socket stays open)
const STALLAFTER = Number(arg('stallafter', 8 * 1024 * 1024)); // ...after this many bytes on that connection
const MAXCONNS = Number(arg('maxconns', 0)); // refuse (429) a request while this many responses are open
const LOG = arg('log', 'labserver.jsonl');
// Only this path is served; anything else (e.g. a stale client still retrying an earlier run) gets 404
// and is logged, so one run can never contaminate another.
// Passed without a leading slash: Git Bash would otherwise rewrite it into a Windows path.
const PATH = '/' + arg('path', 'lab.bin').replace(/^\/+/, '');
const VERIFY = arg('verify', null);
const CHUNK = 32 * 1024;

// Deterministic 1 MiB block (xorshift32).
const BLOCK = Buffer.alloc(1 << 20);
{ let x = 0x12345678; for (let i = 0; i < BLOCK.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; BLOCK[i] = x & 0xff; } }
function fill(buf, offset, len) {
  let o = offset, p = 0;
  while (p < len) {
    const inBlock = o % 1048576, n = Math.min(len - p, BLOCK.length - inBlock);
    // Division (not >>> 20) so offsets beyond 4 GiB do not wrap.
    const kk = Math.floor(o / 1048576) & 0xff;
    BLOCK.copy(buf, p, inBlock, inBlock + n);
    if (kk) for (let i = p; i < p + n; i++) buf[i] ^= kk;
    p += n; o += n;
  }
}

if (VERIFY) {
  // Verification mode: compare a downloaded file against the expected content.
  const got = readFileSync(VERIFY);
  if (got.length !== SIZE) { console.log(`FAIL size ${got.length} != ${SIZE}`); process.exit(1); }
  const exp = Buffer.alloc(1 << 20);
  for (let o = 0; o < SIZE; o += exp.length) {
    const n = Math.min(exp.length, SIZE - o); fill(exp, o, n);
    if (Buffer.compare(exp.subarray(0, n), got.subarray(o, o + n)) !== 0) {
      let i = 0; while (exp[i] === got[o + i]) i++;
      console.log(`FAIL first mismatch at offset ${o + i}`); process.exit(1);
    }
  }
  console.log(`OK ${SIZE} bytes verified, sha256=${createHash('sha256').update(got).digest('hex')}`);
  process.exit(0);
}

const log = createWriteStream(LOG, { flags: 'w' });
const t0 = performance.now();
const now = () => performance.now();
const emit = (o) => log.write(JSON.stringify({ t: +((now() - t0) / 1000).toFixed(3), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Virtual-time FIFO link: each reservation occupies the line for n/rate seconds.
class Pacer {
  constructor(rate, burstMs = 40) { this.rate = rate; this.next = now(); this.burst = burstMs; }
  async take(n, rate = this.rate) {
    const t = Math.max(now() - this.burst, this.next);
    this.next = t + (n / rate) * 1000;
    const wait = this.next - now() - this.burst;
    if (wait > 1) await sleep(wait);
  }
}
const link = new Pacer(LINK);

let sockSeq = 0, reqSeq = 0, activeSockets = 0, activeResponses = 0, bytesTotal = 0;
const server = http.createServer({ keepAlive: true }, async (req, res) => {
  const sock = req.socket;
  if (req.url !== PATH) {
    emit({ ev: 'reject', url: req.url, ua: req.headers['user-agent'] });
    res.writeHead(404); res.end(); return;
  }
  const rid = ++reqSeq;
  const first = sock._labRequests++ === 0;
  const range = req.headers.range ?? null;
  let start = 0, end = SIZE - 1, status = 200;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    if (m[1] === '') { start = Math.max(0, SIZE - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(SIZE - 1, Number(m[2])); }
    if (start >= SIZE || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` }); res.end();
      emit({ ev: 'req', rid, sock: sock._labId, method: req.method, range, status: 416 });
      return;
    }
    status = 206;
  }
  const len = end - start + 1;
  if (MAXCONNS > 0 && req.method !== 'HEAD' && activeResponses >= MAXCONNS && !(start === 0 && end === 0)) {
    emit({ ev: 'req', rid, sock: sock._labId, first, method: req.method, range, ua: req.headers['user-agent'], status: 429 });
    await sleep(REQLAT);
    res.writeHead(429, { 'Content-Length': '0' }); res.end();
    return;
  }
  emit({ ev: 'req', rid, sock: sock._labId, first, method: req.method, range, ifRange: req.headers['if-range'] ?? null,
    ua: req.headers['user-agent'], conn: req.headers.connection ?? null, status, start, end });

  activeResponses++; // counted from admission, so simultaneous arrivals cannot all slip under --maxconns
  await sleep((first ? CONNLAT : 0) + REQLAT);
  const headers = {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(len), 'Accept-Ranges': 'bytes',
    'ETag': `"lab-${SIZE}"`, 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
    'Content-Disposition': `attachment; filename="lab-${SIZE}.bin"`,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { activeResponses--; res.end(); emit({ ev: 'done', rid, sent: 0 }); return; }

  const begin = now();
  let sent = 0, aborted = false;
  const closed = once(res, 'close').then(() => { if (sent < len) aborted = true; }, () => { aborted = true; });
  const conn = { pacer: sock._labPacer, slow: sock._labSlow };
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    while (sent < len && !aborted && !res.destroyed) {
      const n = Math.min(CHUNK, len - sent);
      // Slow-start-like ramp per connection: 10% -> 100% of the per-connection ceiling over RAMP seconds.
      const age = (now() - sock._labBorn) / 1000;
      const ceiling = conn.slow ? SLOWRATE : PERCONN;
      if (JITTER > 0 && now() - sock._labJitterAt > 500) {
        sock._labJitterAt = now(); sock._labJitter = 1 - JITTER + 2 * JITTER * Math.random();
      }
      const rate = (RAMP > 0 ? ceiling * Math.min(1, 0.1 + 0.9 * (age / RAMP)) : ceiling) * sock._labJitter;
      if (sock._labStall && sock._labSent >= STALLAFTER) {
        if (!sock._labStalledLogged) { sock._labStalledLogged = true; emit({ ev: 'stall', sock: sock._labId, rid }); }
        await Promise.race([sleep(600_000), closed]);
        break;
      }
      await conn.pacer.take(n, rate);
      await link.take(n);
      if (aborted || res.destroyed) break;
      fill(buf, start + sent, n);
      sent += n; bytesTotal += n; sock._labSent += n;
      if (!res.write(n === CHUNK ? buf : buf.subarray(0, n))) {
        await Promise.race([once(res, 'drain'), closed]);
      }
    }
    if (!aborted && !res.destroyed) res.end();
  } finally {
    activeResponses--;
    emit({ ev: 'done', rid, sock: sock._labId, sent, len, aborted, ms: Math.round(now() - begin) });
  }
});
server.keepAliveTimeout = 60_000;
server.on('connection', (sock) => {
  sock._labId = ++sockSeq; sock._labRequests = 0; sock._labBorn = now();
  sock._labPacer = new Pacer(PERCONN);
  sock._labSlow = SLOWEVERY > 0 && sock._labId % SLOWEVERY === 0;
  sock._labStall = STALLEVERY > 0 && sock._labId % STALLEVERY === 0;
  sock._labSent = 0; sock._labJitter = 1; sock._labJitterAt = 0;
  activeSockets++;
  emit({ ev: 'open', sock: sock._labId, port: sock.remotePort, slow: sock._labSlow, stall: sock._labStall });
  sock.on('close', () => { activeSockets--; emit({ ev: 'close', sock: sock._labId }); });
});

let lastBytes = 0;
setInterval(() => {
  const d = bytesTotal - lastBytes; lastBytes = bytesTotal;
  if (activeSockets || d) emit({ ev: 'tick', sockets: activeSockets, responses: activeResponses, bps: d * 4, total: bytesTotal });
}, 250).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`labserver ready on http://127.0.0.1:${PORT}${PATH} size=${SIZE} link=${LINK} perconn=${PERCONN} ramp=${RAMP}s slowevery=${SLOWEVERY} log=${LOG}`);
});

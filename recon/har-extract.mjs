#!/usr/bin/env node
// Summarize a HAR export: what protocol the Board Manager UI actually uses.
// Usage: node recon/har-extract.mjs captures/board.har [--bodies]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: har-extract.mjs <file.har> [--bodies]'); process.exit(1); }
const dumpBodies = process.argv.includes('--bodies');

const har = JSON.parse(readFileSync(file, 'utf8'));
const entries = har?.log?.entries ?? [];
console.log(`HAR: ${basename(file)}  —  ${entries.length} entries`);
console.log(`creator: ${har?.log?.creator?.name ?? '?'} ${har?.log?.creator?.version ?? ''}`);

const norm = (u) => { try { const p = new URL(u); return `${p.protocol}//${p.host}${p.pathname}`; } catch { return u; } };
const ctOf = (e) => e.response?.content?.mimeType ?? '';

// --- 1. websocket traffic (Chrome records these as _webSocketMessages) ---
const wsEntries = entries.filter(e => (e._webSocketMessages?.length ?? 0) > 0 || /^wss?:/.test(e.request?.url ?? ''));
console.log(`\n=== WEBSOCKET (${wsEntries.length} connections) ===`);
for (const e of wsEntries) {
  const msgs = e._webSocketMessages ?? [];
  console.log(`\n  ${e.request.url}`);
  console.log(`  status ${e.response?.status}  frames: ${msgs.length}`);
  const sent = msgs.filter(m => m.type === 'send');
  const recv = msgs.filter(m => m.type === 'receive');
  console.log(`  sent ${sent.length} / received ${recv.length}`);
  if (sent.length) {
    console.log('  --- client -> server (first 5, these are subscribe/auth frames) ---');
    for (const m of sent.slice(0, 5)) console.log('    ' + String(m.data).slice(0, 600));
  }
  // group received frames by their shape so repeated event types collapse
  const byShape = new Map();
  for (const m of recv) {
    let key;
    try {
      const j = JSON.parse(m.data);
      key = j.channel ?? j.type ?? j.event ?? j.topic ?? Object.keys(j).sort().join(',');
    } catch { key = '<non-json>'; }
    if (!byShape.has(key)) byShape.set(key, []);
    byShape.get(key).push(m);
  }
  console.log('  --- server -> client, grouped by event key ---');
  for (const [k, ms] of [...byShape].sort((a,b) => b[1].length - a[1].length)) {
    console.log(`\n    [${k}]  x${ms.length}`);
    console.log('    sample: ' + String(ms[0].data).slice(0, 1500));
  }
}

// --- 2. SSE / streaming responses ---
const sse = entries.filter(e => /event-stream/.test(ctOf(e)));
console.log(`\n=== SERVER-SENT EVENTS (${sse.length}) ===`);
for (const e of sse) {
  console.log(`  ${e.request.method} ${e.request.url}`);
  const t = e.response?.content?.text;
  if (t) console.log('  body sample:\n' + t.split('\n').slice(0, 40).map(l => '    ' + l).join('\n'));
}

// --- 3. polled endpoints: same URL hit repeatedly = REST polling ---
const byUrl = new Map();
for (const e of entries) {
  const k = `${e.request.method} ${norm(e.request.url)}`;
  if (!byUrl.has(k)) byUrl.set(k, []);
  byUrl.get(k).push(e);
}
const repeated = [...byUrl].filter(([, v]) => v.length >= 3).sort((a,b) => b[1].length - a[1].length);
console.log(`\n=== REPEATED REQUESTS (>=3x — polling candidates) ===`);
for (const [k, v] of repeated) {
  const ts = v.map(e => new Date(e.startedDateTime).getTime()).sort((a,b) => a-b);
  const gaps = ts.slice(1).map((t,i) => t - ts[i]);
  const median = gaps.length ? gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] : 0;
  console.log(`  x${String(v.length).padStart(4)}  ~${median}ms apart  ${ctOf(v[0]) || '?'}  ${k}`);
}

// --- 4. full endpoint inventory ---
console.log(`\n=== ALL ENDPOINTS ===`);
for (const [k, v] of [...byUrl].sort()) {
  console.log(`  x${String(v.length).padStart(4)}  ${v[0].response?.status}  ${(ctOf(v[0])||'?').split(';')[0].padEnd(26)}  ${k}`);
}

// --- 5. auth surface: are any creds/tokens in play at all? ---
console.log(`\n=== AUTH HEADERS SEEN ===`);
const auth = new Set();
for (const e of entries)
  for (const h of e.request?.headers ?? [])
    if (/^(authorization|x-api-key|cookie|x-auth|token)$/i.test(h.name))
      auth.add(`${h.name}: ${String(h.value).slice(0, 40)}...`);
console.log(auth.size ? [...auth].map(s => '  ' + s).join('\n') : '  (none — unauthenticated LAN access)');

// --- 6. cloud contamination check: anything leaving the LAN? ---
console.log(`\n=== NON-LAN HOSTS CONTACTED ===`);
const hosts = new Set();
for (const e of entries) { try { hosts.add(new URL(e.request.url).host); } catch {} }
const lan = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/;
const ext = [...hosts].filter(h => !lan.test(h));
console.log(ext.length ? ext.map(h => '  ' + h).join('\n') : '  (none — fully local)');

if (dumpBodies) {
  const dir = join(dirname(file), 'har-bodies');
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const e of entries) {
    const t = e.response?.content?.text;
    if (!t || !/json|event-stream/.test(ctOf(e))) continue;
    const name = `${String(n++).padStart(3,'0')}-${norm(e.request.url).replace(/[^a-z0-9]+/gi,'_').slice(-70)}.txt`;
    writeFileSync(join(dir, name), t);
  }
  console.log(`\nwrote ${n} response bodies to ${dir}/`);
}

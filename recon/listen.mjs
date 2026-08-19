#!/usr/bin/env node
// Record live Board Manager events. Zero deps (Node 22+ global WebSocket/fetch).
// Usage:
//   node recon/listen.mjs ws://192.168.1.50:3180/api/events
//   node recon/listen.mjs sse http://192.168.1.50:3180/api/events
//   node recon/listen.mjs poll http://192.168.1.50:3180/api/detection/state 250
// Optionally send subscribe frames on connect:
//   SUBSCRIBE='{"type":"subscribe","channel":"board"}' node recon/listen.mjs ws://...
import { createWriteStream, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
let mode = 'ws', url, interval = 500;
if (args[0] === 'sse' || args[0] === 'poll' || args[0] === 'ws') { mode = args[0]; url = args[1]; interval = Number(args[2] ?? 500); }
else { url = args[0]; mode = url?.startsWith('ws') ? 'ws' : 'sse'; }
if (!url) { console.error('usage: listen.mjs [ws|sse|poll] <url> [pollMs]'); process.exit(1); }

mkdirSync('recon/captures', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = createWriteStream(`recon/captures/live-${mode}-${stamp}.ndjson`);
let n = 0;
const rec = (dir, data) => {
  n++;
  const line = JSON.stringify({ t: new Date().toISOString(), dir, data });
  out.write(line + '\n');
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`[${String(n).padStart(4)}] ${dir} ${s.slice(0, 900)}`);
};
process.on('SIGINT', () => { console.log(`\n${n} messages -> ${out.path}`); out.end(() => process.exit(0)); });
console.log(`mode=${mode} url=${url}\nrecording to ${out.path} — throw some darts, Ctrl-C when done\n`);

if (mode === 'ws') {
  const ws = new WebSocket(url);
  ws.onopen = () => {
    console.log('websocket OPEN');
    const sub = process.env.SUBSCRIBE;
    if (sub) for (const f of sub.split('\n').filter(Boolean)) { ws.send(f); rec('send', f); }
  };
  ws.onmessage = (e) => { let d = e.data; try { d = JSON.parse(d); } catch {} rec('recv', d); };
  ws.onerror = (e) => console.error('WS ERROR:', e.message ?? e);
  ws.onclose = (e) => { console.log(`websocket CLOSED code=${e.code} reason=${e.reason}`); out.end(); };
} else if (mode === 'sse') {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')}`);
  if (!res.body) { console.error('no body'); process.exit(1); }
  let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = {};
      for (const line of raw.split('\n')) {
        const m = /^(\w+):\s?(.*)$/.exec(line);
        if (m) ev[m[1]] = (ev[m[1]] ? ev[m[1]] + '\n' : '') + m[2];
      }
      if (ev.data) { try { ev.data = JSON.parse(ev.data); } catch {} }
      rec('sse', ev);
    }
  }
} else {
  // poll: only record when the response actually changes
  let prev = null;
  for (;;) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const txt = await r.text();
      if (txt !== prev) { prev = txt; let d = txt; try { d = JSON.parse(txt); } catch {} rec('poll', d); }
    } catch (e) { console.error('poll error:', e.message); }
    await new Promise(r => setTimeout(r, interval));
  }
}

import { startFakeBoard } from './server.ts';

/**
 * A stand-in for the Autodarts Board Manager, speaking its local protocol on
 * its own port. Point the bridge at it with:
 *
 *   SOURCE=autodarts BOARD_URL=http://localhost:3180 npm run dev:bridge
 *
 * Then throw darts:
 *
 *   curl -X PUT  localhost:3180/api/start
 *   curl -X POST localhost:3180/sim/turn -d '{"segments":["T20","T20","T20"]}'
 *   curl -X POST localhost:3180/sim/disconnect -d '{"ms":5000}'
 */
const port = Number(process.env.FAKE_BOARD_PORT ?? 3180);

const fake = await startFakeBoard({
  port,
  motion: process.env.FAKE_MOTION === '1',
  autoStart: process.env.FAKE_AUTOSTART !== '0',
});

console.log(`[fakeboard] listening on :${fake.port}`);
console.log(`[fakeboard] events   ws://localhost:${fake.port}/api/events`);
console.log(`[fakeboard] control  POST /sim/throw · /sim/turn · /sim/takeout · /sim/disconnect`);
console.log('[fakeboard] the throw payload here matches a real board — see recon/FINDINGS.md §3');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[fakeboard] ${signal}, shutting down`);
    void fake.close().then(() => process.exit(0));
  });
}

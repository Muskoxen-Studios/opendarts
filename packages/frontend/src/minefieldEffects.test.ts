import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent, MatchView } from '@darts/schema';
import { connect, mutableState, store } from './store.ts';
import { mmToSvg, segmentCentre } from './boardGeometry.ts';

class Socket {
  static latest: Socket;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { Socket.latest = this; }
}
function send(event: DomainEvent): void {
  Socket.latest.onmessage!({ data: JSON.stringify({ type: 'domain', events: [event] }) });
}
function explosion(overrides: Partial<Extract<DomainEvent, { type: 'minefield.exploded' }>> = {}): Extract<DomainEvent, { type: 'minefield.exploded' }> {
  return { type: 'minefield.exploded', playerId: 'alice', number: 20, hazard: 'mine', value: -20, resetsScore: false, segment: { number: 20, ring: 'SINGLE_OUTER' }, coords: null, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('WebSocket', Socket);
  mutableState.boardEffect = null;
  mutableState.view = null;
  mutableState.effects = 'full';
  connect();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Minefield board effects', () => {
  it('uses the exploding dart segment even before the new view arrives and without coordinates', () => {
    send(explosion());
    expect(store.boardEffect).toMatchObject({ kind: 'mine', title: 'Boom!', body: '-20 points', color: '#ff425e', origin: segmentCentre({ number: 20, ring: 'SINGLE_OUTER' }) });
    expect(store.boardEffect!.origin).not.toEqual({ x: 500, y: 500 });
  });
  it('uses supplied coordinates and distinguishes blast-zone penalties from direct score resets', () => {
    send(explosion({ number: 5, hazard: 'blast', value: -5, segment: { number: 5, ring: 'SINGLE_INNER' }, coords: { x: 0.1, y: 0.2 } }));
    expect(store.boardEffect).toMatchObject({ kind: 'blast', title: 'Blast zone!', body: '-5 points', color: '#ffb347', origin: mmToSvg({ x: 0.1, y: 0.2 }) });
    send(explosion({ resetsScore: true, value: -100 }));
    expect(store.boardEffect!.body).toBe('Score reset to 0');
    send(explosion({ resetsScore: true, value: 0 }));
    expect(store.boardEffect!.body).toBe('Score unchanged');
  });
  it('gives defusals a separate green effect, and still reports outcomes with effects disabled', () => {
    mutableState.effects = 'off';
    send({ type: 'minefield.defused', playerId: 'alice', number: 25, segment: { number: 25, ring: 'BULL' }, coords: null });
    expect(store.boardEffect).toMatchObject({ kind: 'defuse', title: 'Defused!', body: 'Bull is safe again', color: '#5cdfac', origin: { x: 500, y: 500 } });
    send({ type: 'minefield.defused', playerId: 'alice', number: 25, segment: { number: 25, ring: 'BULL' }, coords: null, rearmed: true });
    expect(store.boardEffect!.body).toBe('Bull is armed again (0 HP)');
  });
  it('restarts on consecutive explosions and expires relative to the newest one', () => {
    send(explosion());
    const key = store.boardEffect!.key;
    vi.advanceTimersByTime(1000);
    send(explosion());
    expect(store.boardEffect!.key).toBeGreaterThan(key);
    vi.advanceTimersByTime(2000);
    expect(store.boardEffect).not.toBeNull();
    vi.advanceTimersByTime(600);
    expect(store.boardEffect).toBeNull();
  });
  it('clears stale effects when switching matches or correcting the last dart', () => {
    const view: MatchView = {
      matchId: 'one', gameType: 'minefield', status: 'playing', players: [], activePlayerId: null,
      awaitingTakeout: false, turn: { throws: [], total: 0, dartsRemaining: 3, hints: [] },
      leg: 1, set: 1, round: 1, roundLimit: null, winnerId: null,
      recent: [{ id: 'dart', label: 'S20', value: 20, playerId: 'alice' }],
    };
    Socket.latest.onmessage!({ data: JSON.stringify({ type: 'view', view }) });
    send(explosion());
    Socket.latest.onmessage!({ data: JSON.stringify({ type: 'view', view: { ...view, recent: [{ ...view.recent[0], label: 'D20' }] } }) });
    expect(store.boardEffect).toBeNull();
    send(explosion());
    Socket.latest.onmessage!({ data: JSON.stringify({ type: 'view', view: { ...view, matchId: 'two' } }) });
    expect(store.boardEffect).toBeNull();
  });

});

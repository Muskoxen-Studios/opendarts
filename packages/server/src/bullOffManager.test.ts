import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameConfigSchema } from '@darts/schema';
import { dart, resetDartIds } from '../../engine/src/testkit.ts';
import { openDatabase } from './db.ts';
import { MatchManager, type ServerEvent } from './matchManager.ts';
import { Store } from './store.ts';

beforeEach(resetDartIds);
function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const players = [store.createProfile('Alice'), store.createProfile('Bob')];
  const events: ServerEvent[] = [];
  const reset = vi.fn();
  const manager = new MatchManager(store, e => events.push(e), reset);
  return { db, store, players, events, reset, manager };
}

describe('bull-off board routing', () => {
  it('captures real darts until takeout, ignoring extra darts and empty takeouts', () => {
    const { db, manager, players, reset } = setup();
    const session = manager.startBullOff(players);
    const shot = dart('25'); shot.source = 'board';
    manager.onBoardEvent({ type: 'takeout.completed' });
    expect(manager.bullOff?.activePlayerId).toBe(players[0]!.id);
    manager.onBoardEvent({ type: 'throw.detected', throw: shot });
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('BULL') });
    expect(manager.bullOff).toMatchObject({ awaitingTakeout: true, activePlayerId: players[0]!.id });
    manager.onBoardEvent({ type: 'takeout.completed' });
    expect(manager.bullOff?.activePlayerId).toBe(players[1]!.id);
    expect(reset).toHaveBeenCalledTimes(1);
    manager.commandBullOff(session.id, { type: 'CANCEL' }); db.close();
  });

  it('keeps bull-off throws out of match history, career stats and achievements', () => {
    const { db, manager, players, store, events } = setup();
    const session = manager.startBullOff(players);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('S1') });
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('BULL') });
    const result = manager.commandBullOff(session.id, { type: 'FINISH' });
    expect(result.playerIds).toEqual([players[1]!.id, players[0]!.id]);
    expect(store.listMatches()).toEqual([]);
    expect(events.some(e => e.type === 'domain' || e.type === 'achievements.unlocked')).toBe(false);
    expect(manager.bullOff).toBeNull();
    const match = manager.start(GameConfigSchema.parse({ gameType: 'x01' }), result.playerIds!.map(id => players.find(p => p.id === id)!));
    expect(match.activePlayerId).toBe(players[1]!.id);
    expect(match.players.map(p => p.score)).toEqual([501, 501]); db.close();
  });

  it('supports manual distances, undo, restart, stale-session rejection and cancel', () => {
    const { db, manager, players } = setup();
    const session = manager.startBullOff(players);
    manager.commandBullOff(session.id, { type: 'MEASURE', distanceMm: 45 });
    manager.commandBullOff(session.id, { type: 'UNDO' });
    expect(manager.bullOff?.activePlayerId).toBe(players[0]!.id);
    manager.commandBullOff(session.id, { type: 'RESTART' });
    expect(manager.bullOff?.round).toBe(1);
    expect(manager.bullOff?.results).toEqual({});
    expect(() => manager.commandBullOff(session.id, { type: 'CANCEL' })).toThrow('no longer open');
    manager.commandBullOff(manager.bullOff!.id, { type: 'CANCEL' });
    expect(manager.bullOff).toBeNull(); db.close();
  });

  it('prevents an unfinished bull-off being applied or overwritten by a match', () => {
    const { db, manager, players } = setup();
    const session = manager.startBullOff(players);
    expect(() => manager.commandBullOff(session.id, { type: 'FINISH' })).toThrow('Complete');
    expect(() => manager.startBullOff(players)).toThrow('already open');
    expect(() => manager.start(GameConfigSchema.parse({ gameType: 'x01' }), players)).toThrow('Finish or cancel');
    expect(manager.bullOff?.id).toBe(session.id); db.close();
  });

  it('allows bull-off while preserving an ongoing match and its command log', () => {
    const { db, manager, players, store } = setup();
    manager.start(GameConfigSchema.parse({ gameType: 'x01' }), players);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('S20') });
    const match = manager.view!;
    const record = store.loadMatchRecord(match.matchId);
    const session = manager.startBullOff(players);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('25') });
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('BULL') });
    manager.apply({ type: 'UNDO' });
    expect(manager.view).toEqual(match);
    expect(store.loadMatchRecord(match.matchId)).toEqual(record);
    const result = manager.commandBullOff(session.id, { type: 'FINISH' });
    expect(result.playerIds).toEqual([players[1]!.id, players[0]!.id]);
    expect(manager.view).toEqual(match);
    const next = manager.start(GameConfigSchema.parse({ gameType: 'x01' }), result.playerIds!.map(id => players.find(player => player.id === id)!));
    expect(next.activePlayerId).toBe(players[1]!.id);
    expect(next.players.map(player => player.score)).toEqual([501, 501]);
    expect(store.summaryFor(match.matchId)?.winnerId).toBeNull(); db.close();
  });

  it('resumes scoring the preserved match after cancelling a bull-off', () => {
    const { db, manager, players, store } = setup();
    manager.start(GameConfigSchema.parse({ gameType: 'x01' }), players);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('S20') });
    const match = manager.view!;
    const session = manager.startBullOff(players);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('BULL') });
    manager.onBoardEvent({ type: 'takeout.completed' });
    manager.commandBullOff(session.id, { type: 'CANCEL' });
    expect(manager.view).toEqual(match);
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('S1') });
    expect(manager.view?.players[0]?.score).toBe(480);
    expect(store.listMatches()).toHaveLength(1); db.close();
  });

  it('leaves a previous finished match and its log unchanged throughout bull-off', () => {
    const { db, manager, players, store } = setup();
    manager.start(GameConfigSchema.parse({ gameType: 'x01' }), players);
    manager.apply({ type: 'END_MATCH' });
    const previous = manager.view!;
    const record = store.loadMatchRecord(previous.matchId);
    const session = manager.startBullOff(players);
    manager.apply({ type: 'UNDO' });
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('BULL') });
    manager.onBoardEvent({ type: 'throw.detected', throw: dart('25') });
    expect(manager.view).toEqual(previous);
    expect(store.loadMatchRecord(previous.matchId)).toEqual(record);
    manager.commandBullOff(session.id, { type: 'CANCEL' });
    expect(store.listMatches()).toHaveLength(1); db.close();
  });
});

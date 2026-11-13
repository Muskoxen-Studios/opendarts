import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';
const sequence = Array.from({ length: 20 }, (_, i) => `S${i + 1}`);
function newMatch(overrides: Record<string, unknown> = {}, solo = false): Match {
  const m = new Match('clock', solo ? players('Alice') : players('Alice', 'Bob'), { gameType: 'aroundtheclock', finishBull: false, ...overrides });
  m.apply({ type: 'START' }); return m;
}
beforeEach(resetDartIds);
describe('Around the Clock', () => {
  it('supports the Autodarts mode, order and repeated-hit options with a default final bull', () => {
    const defaults = new Match('defaults', players('Alice'), { gameType: 'aroundtheclock' });
    expect(defaults.config).toMatchObject({ finishBull: true, mode: 'full', hits: 1, order: 'ascending' });
    const m = newMatch({ mode: 'double', order: 'descending', hits: 2 });
    play(m, 'T20', 'D20'); expect(m.view.players[0]?.detail).toMatchObject({ target: 20, hitsOnTarget: 1 });
    play(m, 'D20'); expect(m.view.players[0]?.detail.target).toBe(19);
    const random = newMatch({ order: 'random', seed: 42 });
    expect((random.view.players[0]?.detail.sequence as number[]).slice().sort((a,b)=>a-b)).toEqual(Array.from({length:20},(_,i)=>i+1));
    expect(Match.fromLog(random.matchId,random.players,random.config,[...random.log]).view).toEqual(random.view);
  });
  it('requires the current number and advances only one step for doubles and trebles', () => {
    const m = newMatch();
    play(m, 'T1', 'T3', 'D2');
    expect(scoreOf(m, 'alice')).toBe(2);
    expect(m.view.players[0]?.detail.target).toBe(3);
    expect(m.allEvents.filter(e => e.type === 'throw.recorded').map(e => e.value)).toEqual([1, 0, 1]);
  });
  it('counts neither misses nor bulls before the bull target', () => {
    const m = newMatch(); play(m, 'MISS', '25', 'BULL');
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(m.view.players[0]?.detail.target).toBe(1);
  });
  it('keeps separate player targets and recomputes hints after each hit', () => {
    const m = newMatch();
    expect(m.view.turn.hints).toEqual(['1', '1', '1']);
    play(m, 'S1'); expect(m.view.turn.hints).toEqual(['2', '2']);
    play(m, 'S2', 'S3');
    expect(m.view.activePlayerId).toBe('bob');
    expect(m.view.turn.hints).toEqual(['1', '1', '1']);
    expect(m.view.players[0]?.detail.hitRate).toBe(1);
  });
  it('wins immediately on 20 in solo practice, without an extra dart or bull', () => {
    const m = newMatch({}, true); play(m, ...sequence);
    expect(m.view).toMatchObject({ status: 'finished', winnerId: 'alice' });
    expect(scoreOf(m, 'alice')).toBe(20);
    expect(m.view.players[0]?.detail.target).toBeNull();
  });
  it.each(['25', 'BULL'])('optionally requires a final bull and accepts %s', bull => {
    const m = newMatch({ finishBull: true }, true); play(m, ...sequence);
    expect(m.finished).toBe(false);
    expect(m.view.turn.hints).toEqual(['25']);
    play(m, 'S20'); expect(m.finished).toBe(false);
    play(m, bull);
    expect(m.view.winnerId).toBe('alice'); expect(scoreOf(m, 'alice')).toBe(21);
  });
  it('holds takeout, rejects a fourth dart and releases a held turn only once', () => {
    const m = newMatch();
    for (const label of ['S1', 'S2', 'S3']) m.apply(throwCmd(label));
    expect(m.view).toMatchObject({ awaitingTakeout: true, activePlayerId: 'alice' });
    expect(m.view.turn.hints).toEqual([]);
    expect(m.apply(throwCmd('S4'))).toEqual([]);
    m.apply({ type: 'NEXT_PLAYER' });
    expect(m.view.activePlayerId).toBe('bob');
    expect(m.allEvents.filter(e => e.type === 'turn.completed')).toHaveLength(1);
  });
  it('can end turns early and uses the most completed targets at a round limit', () => {
    const m = newMatch({ roundLimit: 1 });
    play(m, 'S1'); m.apply({ type: 'NEXT_PLAYER' });
    play(m, 'S1', 'S2'); m.apply({ type: 'NEXT_PLAYER' });
    expect(m.view.winnerId).toBe('bob');
  });
  it('undoes across a turn boundary and corrects a hit without leaving stale progress', () => {
    const m = newMatch(); const first = throwCmd('S1'); m.apply(first);
    play(m, 'S2', 'S3', 'S1'); m.apply({ type: 'UNDO' });
    expect(scoreOf(m, 'bob')).toBe(0);
    if (first.type !== 'THROW') throw Error('expected throw');
    m.apply({ type: 'CORRECT_THROW', throwId: first.throw.id, segment: { number: 0, ring: 'MISS' } });
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(m.view.players[0]?.detail.target).toBe(1);
  });
  it('resets the sequence on restart and new legs, with sets supported', () => {
    const m = newMatch({ setsToWin: 2 }, true);
    play(m, 'S1', 'S2'); m.apply({ type: 'RESTART_LEG' });
    expect(m.view).toMatchObject({ round: 1, turn: { total: 0, hints: ['1', '1', '1'] } });
    play(m, ...sequence); expect(m.view).toMatchObject({ status: 'playing', set: 2 });
    expect(scoreOf(m, 'alice')).toBe(0);
    play(m, ...sequence); expect(m.view.winnerId).toBe('alice');
  });
  it('seeds joins at 1 and removes players without resetting an ongoing subtotal', () => {
    const m = newMatch(); play(m, 'S1'); m.apply({ type: 'REMOVE_PLAYER', playerId: 'bob' });
    expect(m.view.turn.total).toBe(1);
    m.apply({ type: 'ADD_PLAYER', player: players('Carol')[0]! });
    expect(m.view.players.find(p => p.playerId === 'carol')?.detail.target).toBe(1);
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'alice' });
    expect(m.view.activePlayerId).toBe('carol');
    expect(m.view.turn.throws).toEqual([]);
  });
});

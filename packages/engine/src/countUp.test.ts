import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

function newMatch(overrides: Record<string, unknown> = {}, solo = false): Match {
  const m = new Match('count-up', solo ? players('Alice') : players('Alice', 'Bob'), { gameType: 'countup', ...overrides });
  m.apply({ type: 'START' }); return m;
}
beforeEach(resetDartIds);
describe('Count Up', () => {
  it('defaults to eight rounds and scores standard singles, doubles, trebles and both bulls', () => {
    const m = newMatch({}, true);
    expect(m.config).toMatchObject({ rounds: 8, roundLimit: null, legsToWin: 1, setsToWin: 1 });
    play(m, 'S20', 'D20', 'T20', '25', 'BULL', 'MISS');
    expect(scoreOf(m, 'alice')).toBe(195);
    expect(m.view.players[0]?.detail.visits).toEqual([120, 75]);
    expect(m.view.round).toBe(3);
  });
  it('allows solo practice, finishing after exactly 24 darts by default', () => {
    const m = newMatch({}, true);
    play(m, ...Array<string>(23).fill('T20'));
    expect(m.finished).toBe(false);
    play(m, 'T20');
    expect(m.view.winnerId).toBe('alice');
    expect(scoreOf(m, 'alice')).toBe(1440);
  });
  it('waits for everyone to play the final round and awards the highest total', () => {
    const m = newMatch({ rounds: 1 });
    play(m, 'S20', 'S20', 'S20');
    expect(m.finished).toBe(false);
    play(m, 'T20', 'T20', 'T20');
    expect(m.view.winnerId).toBe('bob');
  });
  it('resolves equal scores by stable seat order', () => {
    const m = newMatch({ rounds: 1 });
    play(m, ...Array<string>(6).fill('MISS'));
    expect(m.view.winnerId).toBe('alice');
  });
  it('holds three darts for takeout, rejects extras and does not complete the turn twice', () => {
    const m = newMatch();
    for (let i = 0; i < 3; i++) m.apply(throwCmd('T20'));
    expect(m.view).toMatchObject({ awaitingTakeout: true, activePlayerId: 'alice' });
    expect(m.apply(throwCmd('T20'))).toEqual([]);
    expect(m.view.turn.throws).toHaveLength(3);
    m.apply({ type: 'NEXT_PLAYER' });
    expect(m.view.activePlayerId).toBe('bob');
    expect(m.allEvents.filter(e => e.type === 'turn.completed')).toHaveLength(1);
  });
  it('supports ending a turn early, including zero darts', () => {
    const m = newMatch({ rounds: 1 });
    play(m, 'S5'); m.apply({ type: 'NEXT_PLAYER' }); m.apply({ type: 'NEXT_PLAYER' });
    expect(m.view.winnerId).toBe('alice');
    expect(m.allEvents.filter(e => e.type === 'turn.completed')).toMatchObject([{ total: 5, darts: 1 }, { total: 0, darts: 0 }]);
  });
  it('applies an earlier round limit after equal turns', () => {
    const m = newMatch({ rounds: 8, roundLimit: 1 });
    play(m, 'S1', 'MISS', 'MISS', 'D1', 'MISS', 'MISS');
    expect(m.view.winnerId).toBe('bob');
  });
  it('resets scores, rounds and visits and rotates the starter for a new leg', () => {
    const m = newMatch({ rounds: 1, legsToWin: 2 });
    play(m, 'S20', 'MISS', 'MISS', 'MISS', 'MISS', 'MISS');
    expect(m.view).toMatchObject({ leg: 2, round: 1, activePlayerId: 'bob' });
    expect(m.view.players.map(p => p.score)).toEqual([0, 0]);
    expect(m.view.players[0]?.detail.visits).toEqual([]);
  });
  it('supports sets', () => {
    const m = newMatch({ rounds: 1, setsToWin: 2 }, true);
    play(m, 'S1', 'MISS', 'MISS');
    expect(m.view).toMatchObject({ status: 'playing', set: 2 });
    play(m, 'S1', 'MISS', 'MISS');
    expect(m.view.winnerId).toBe('alice');
  });
  it('undoes across takeout and corrects a result after the leg ended', () => {
    const m = newMatch({ rounds: 1 });
    const first = throwCmd('T20'); m.apply(first);
    play(m, 'MISS', 'MISS', 'S1');
    m.apply({ type: 'UNDO' });
    expect(scoreOf(m, 'bob')).toBe(0);
    play(m, 'S1', 'S1', 'S1');
    expect(m.finished).toBe(true);
    if (first.type !== 'THROW') throw Error('expected throw');
    m.apply({ type: 'CORRECT_THROW', throwId: first.throw.id, segment: { number: 0, ring: 'MISS' } });
    expect(m.view.winnerId).toBe('bob');
  });
  it('handles restart, joins and removal without changing the current turn subtotal', () => {
    const m = newMatch();
    play(m, 'T20'); m.apply({ type: 'REMOVE_PLAYER', playerId: 'bob' });
    expect(m.view.turn.total).toBe(60);
    m.apply({ type: 'ADD_PLAYER', player: players('Carol')[0]! });
    expect(scoreOf(m, 'carol')).toBe(0);
    m.apply({ type: 'RESTART_LEG' });
    expect(m.view).toMatchObject({ round: 1, turn: { total: 0, throws: [] } });
    expect(scoreOf(m, 'alice')).toBe(0);
  });
  it('rejects invalid round counts', () => {
    for (const rounds of [0, -1, 1.5, 101]) expect(() => newMatch({ rounds })).toThrow();
  });
});

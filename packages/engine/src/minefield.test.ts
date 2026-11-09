import { beforeEach, describe, expect, it } from 'vitest';
import { MinefieldConfigSchema } from '@darts/schema';
import { Match } from './match.ts';
import { dart, play, players, resetDartIds, scoreOf, seg, throwCmd } from './testkit.ts';

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('minefield-test', players('Alice', 'Bob'), {
    gameType: 'minefield', ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

function field(m: Match, number: number) {
  const cells = m.view.players[0]!.detail.field as {
    number: number; hp: number; explosions: number; nextMultiplier: number | null;
  }[];
  return cells.find((cell) => cell.number === number)!;
}

beforeEach(resetDartIds);

describe('Minefield', () => {
  it('validates configuration and supplies the agreed defaults', () => {
    expect(MinefieldConfigSchema.parse({ gameType: 'minefield' })).toMatchObject({
      hitPoints: 3, targetScore: 301, legsToWin: 1, setsToWin: 1, roundLimit: null,
    });
    for (const hitPoints of [0, -1, 1.5, 10]) {
      expect(() => newMatch({ hitPoints })).toThrow();
    }
    expect(() => newMatch({ targetScore: 0 })).toThrow();
  });

  it('scores the arming dart normally and removes one HP per dart across rings', () => {
    const m = newMatch();
    m.apply(throwCmd('T20'));
    expect(field(m, 20).hp).toBe(2);
    m.apply(throwCmd('D20'));
    expect(field(m, 20).hp).toBe(1);
    m.apply(throwCmd('S20'));
    expect(scoreOf(m, 'alice')).toBe(120);
    expect(field(m, 20)).toEqual({ number: 20, hp: 0, explosions: 0, nextMultiplier: 2 });
    expect(m.view.awaitingTakeout).toBe(true);
    expect(m.view.activePlayerId).toBe('alice');
    expect(m.apply(throwCmd('S1'))).toEqual([]);
    expect(field(m, 1).hp).toBe(3);
  });

  it('shares mines across players and applies 2x/3x/5x base penalties before resetting only that mine', () => {
    const m = newMatch();
    play(m, '20', '20', '20');
    const first = m.apply(throwCmd('T20'));
    expect(first).toContainEqual({ type: 'throw.recorded', playerId: 'bob', dartIndex: 0, value: -40 });
    expect(m.view.turn.throws[0]!.value).toBe(-40);
    expect(field(m, 20).nextMultiplier).toBe(3);
    m.apply(throwCmd('D20'));
    expect(field(m, 20).nextMultiplier).toBe(5);
    const third = m.apply(throwCmd('20'));
    expect(third).toContainEqual({ type: 'turn.completed', playerId: 'bob', darts: 3, total: -200, busted: false });
    expect(m.view.turn.total).toBe(-200);
    expect(scoreOf(m, 'bob')).toBe(-200);
    expect(scoreOf(m, 'alice')).toBe(60);
    expect(field(m, 20)).toEqual({ number: 20, hp: 3, explosions: 0, nextMultiplier: null });
    m.apply({ type: 'ADVANCE_TURN' });
    play(m, '19', '20', '20', '20');
    expect(field(m, 19).hp).toBe(2);
    expect(field(m, 20).nextMultiplier).toBe(2);
    m.apply(throwCmd('20'));
    expect(field(m, 20).explosions).toBe(1);
    expect(field(m, 19).hp).toBe(2);
  });

  it('shares both bull rings and ignores misses', () => {
    const m = newMatch();
    play(m, '25', 'BULL', '25');
    expect(scoreOf(m, 'alice')).toBe(100);
    expect(field(m, 25).hp).toBe(0);
    play(m, 'BULL', 'MISS', '25');
    expect(scoreOf(m, 'bob')).toBe(-125);
    expect(field(m, 25)).toMatchObject({ hp: 0, explosions: 2, nextMultiplier: 5 });
    m.apply(throwCmd('BULL'));
    expect(scoreOf(m, 'alice')).toBe(-25);
    expect(field(m, 25).hp).toBe(3);
    expect(field(m, 1).hp).toBe(3);
  });

  it('supports configurable HP and wins immediately at or beyond the target', () => {
    const m = newMatch({ hitPoints: 1, targetScore: 70 });
    play(m, 'T20', '20'); // 60 - 40
    expect(field(m, 20).nextMultiplier).toBe(3);
    m.apply(throwCmd('T19'));
    expect(scoreOf(m, 'alice')).toBe(77);
    expect(m.view.winnerId).toBe('alice');
    expect(m.view.status).toBe('finished');
  });

  it('resets scores and the field on a new leg, rotates the starter and rolls up sets', () => {
    const m = newMatch({ targetScore: 20, legsToWin: 1, setsToWin: 2, hitPoints: 1 });
    m.apply(throwCmd('20'));
    expect(m.view.set).toBe(2);
    expect(m.view.activePlayerId).toBe('bob');
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(field(m, 20).hp).toBe(1);
    m.apply({ type: 'NEXT_PLAYER' });
    m.apply(throwCmd('20'));
    expect(m.view.winnerId).toBe('alice');
  });

  it('honours the round limit after both full and manually ended turns', () => {
    for (const handover of ['NEXT_PLAYER', 'ADVANCE_TURN'] as const) {
      const m = newMatch({ roundLimit: 1, targetScore: 1000 });
      if (handover === 'NEXT_PLAYER') {
        m.apply(throwCmd('20'));
        m.apply({ type: handover });
        m.apply(throwCmd('19'));
      } else {
        play(m, '20', 'MISS', 'MISS');
        for (const label of ['19', 'MISS', 'MISS']) m.apply(throwCmd(label));
        expect(m.view.status).toBe('playing');
      }
      m.apply({ type: handover });
      expect(m.view.status).toBe('finished');
      expect(m.view.winnerId).toBe('alice');
    }
  });

  it('restarts scores, mines, turn and round counters', () => {
    const m = newMatch({ hitPoints: 1 });
    play(m, '20', '20', 'MISS', '19', 'MISS', 'MISS');
    expect(m.view.round).toBe(2);
    m.apply({ type: 'RESTART_LEG' });
    expect(m.view.round).toBe(1);
    expect(m.view.activePlayerId).toBe('alice');
    expect(m.view.turn.throws).toEqual([]);
    expect(m.view.players.map((p) => p.score)).toEqual([0, 0]);
    expect(field(m, 20)).toMatchObject({ hp: 1, explosions: 0 });
  });

  it('replays corrections and undo across explosions, restoring HP and signed scores', () => {
    const m = newMatch({ hitPoints: 1 });
    const arming = dart('20');
    m.apply({ type: 'THROW', throw: arming });
    m.apply(throwCmd('20'));
    expect(scoreOf(m, 'alice')).toBe(-20);
    m.apply({ type: 'CORRECT_THROW', throwId: arming.id, segment: seg('19') });
    expect(scoreOf(m, 'alice')).toBe(39);
    expect(field(m, 20).explosions).toBe(0);
    m.apply({ type: 'UNDO' });
    expect(scoreOf(m, 'alice')).toBe(19);
    expect(field(m, 20).hp).toBe(1);
    const restored = Match.fromLog(m.matchId, m.players, m.config, [...m.log]);
    expect(restored.view).toEqual(m.view);
  });

  it('undoes a third explosion and restores the armed 5x mine', () => {
    const m = newMatch({ hitPoints: 1 });
    play(m, '20', '20', '20');
    m.apply(throwCmd('20'));
    expect(field(m, 20).hp).toBe(1);
    m.apply({ type: 'UNDO' });
    expect(field(m, 20)).toMatchObject({ hp: 0, explosions: 2, nextMultiplier: 5 });
    expect(scoreOf(m, 'bob')).toBe(0);
  });

  it('preserves the field when players join or leave and keeps current turn values intact', () => {
    const m = newMatch({ hitPoints: 1 });
    m.apply(throwCmd('20'));
    m.apply({ type: 'ADD_PLAYER', player: players('Cara')[0]! });
    expect(scoreOf(m, 'cara')).toBe(0);
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'bob' });
    expect(m.view.turn.total).toBe(20);
    expect(m.view.turn.throws[0]!.value).toBe(20);
    expect(field(m, 20).hp).toBe(0);
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'alice' });
    expect(m.view.activePlayerId).toBe('cara');
    m.apply(throwCmd('20'));
    expect(scoreOf(m, 'cara')).toBe(-40);
  });

  it('ends early using highest score, including negative scores', () => {
    const m = newMatch({ hitPoints: 1 });
    play(m, '20', '20', '20', '19', '19', '19');
    expect(scoreOf(m, 'alice')).toBe(-80);
    expect(scoreOf(m, 'bob')).toBe(-76);
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('bob');
  });
});

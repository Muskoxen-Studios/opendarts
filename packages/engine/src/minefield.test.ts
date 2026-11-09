import { beforeEach, describe, expect, it } from 'vitest';
import { MinefieldConfigSchema } from '@darts/schema';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, seg, throwCmd } from './testkit.ts';

function newMatch(overrides: Record<string, unknown> = {}, names = ['Alice', 'Bob']): Match {
  const m = new Match('minefield-test', players(...names), {
    gameType: 'minefield', targetScore: 10000, ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

function field(m: Match, number: number) {
  const cells = m.view.players[0]!.detail.field as {
    number: number; hp: number; multiplier: number; nextMultiplier: number | null;
  }[];
  return cells.find((cell) => cell.number === number)!;
}

function arm(m: Match, number: number): void {
  play(m, ...Array.from({ length: field(m, number).hp }, () => String(number)));
}

beforeEach(resetDartIds);

describe('Minefield', () => {
  it('defaults to automatic HP, normalizes legacy HP and rejects invalid values', () => {
    expect(MinefieldConfigSchema.parse({ gameType: 'minefield' })).toMatchObject({
      hitPoints: null, targetScore: 301, legsToWin: 1, setsToWin: 1, roundLimit: null,
    });
    for (const hitPoints of [0, -1, 1.5, 6.5]) {
      expect(() => newMatch({ hitPoints })).toThrow();
    }
    expect(() => newMatch({ targetScore: 0 })).toThrow();
    for (const hitPoints of [1, 3, 5]) {
      expect(newMatch({ hitPoints }).config).toMatchObject({ hitPoints: 6 });
      expect(field(newMatch({ hitPoints }), 20).hp).toBe(6);
    }
  });

  it('scales automatic HP with player count, with a six-HP floor', () => {
    for (const [names, expected] of [
      [['Alice'], 6], [['Alice', 'Bob'], 6], [['Alice', 'Bob', 'Cara'], 9],
      [['Alice', 'Bob', 'Cara', 'Dan'], 12],
    ] as const) {
      const m = newMatch({}, [...names]);
      expect(m.view.players[0]!.detail.hitPoints).toBe(expected);
      expect(field(m, 20).hp).toBe(expected);
      expect(field(m, 25).hp).toBe(expected);
    }
    expect(field(newMatch({ hitPoints: 8 }, ['Alice', 'Bob', 'Cara']), 20).hp).toBe(8);
  });

  it('removes one HP per safe dart regardless of ring and scores the arming dart', () => {
    const m = newMatch();
    play(m, 'T20', 'D20', '20');
    expect(scoreOf(m, 'alice')).toBe(120);
    expect(field(m, 20).hp).toBe(3);
    m.apply(throwCmd('T20'));
    m.apply(throwCmd('D20'));
    m.apply(throwCmd('20'));
    expect(scoreOf(m, 'bob')).toBe(120);
    expect(field(m, 20)).toEqual({ number: 20, hp: 0, multiplier: 1, nextMultiplier: 1 });
    expect(m.view.awaitingTakeout).toBe(true);
    expect(m.view.activePlayerId).toBe('bob');
    expect(m.apply(throwCmd('1'))).toEqual([]);
    expect(field(m, 1).hp).toBe(6);
  });

  it('explodes on the very next hit, resets immediately, and lets later darts score', () => {
    const m = newMatch();
    arm(m, 20);
    const events = m.apply(throwCmd('20'));
    expect(events).toContainEqual({ type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: -20 });
    expect(m.view.turn.throws[0]!.value).toBe(-20);
    expect(field(m, 20)).toEqual({ number: 20, hp: 6, multiplier: 1.5, nextMultiplier: null });
    expect(field(m, 19)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply(throwCmd('20'));
    m.apply(throwCmd('20'));
    expect(m.view.turn.throws.map((t) => t.value)).toEqual([-20, 20, 20]);
    expect(m.view.turn.total).toBe(20);
    expect(field(m, 20).hp).toBe(4);
    expect(m.view.awaitingTakeout).toBe(true);
  });

  it.each([
    { number: 20, label: 'D20', value: 40 },
    { number: 20, label: 'T20', value: 60 },
    { number: 25, label: 'BULL', value: 50 },
  ])('defuses an armed $number with $label, scoring $value without escalating', ({ number, label, value }) => {
    const m = newMatch();
    arm(m, number);
    play(m, String(number)); // explode once, so defusing must also preserve a raised multiplier
    arm(m, number);
    expect(field(m, number).nextMultiplier).toBe(1.5);
    const events = m.apply(throwCmd(label));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value })]));
    expect(field(m, number)).toMatchObject({ hp: 6, multiplier: 1.5, nextMultiplier: null });
    m.apply({ type: 'UNDO' });
    expect(field(m, number)).toMatchObject({ hp: 0, multiplier: 1.5 });
  });

  it('refolds a corrected defuse as an explosion', () => {
    const m = newMatch();
    arm(m, 20);
    const command = throwCmd('D20');
    m.apply(command);
    if (command.type !== 'THROW') throw new Error('expected throw');
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply({ type: 'CORRECT_THROW', throwId: command.throw.id, segment: seg('20') });
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    expect(m.view.turn.throws.at(-1)!.value).toBe(-20);
  });

  it('requires full HP depletion between explosions and raises each new cycle by 0.5x', () => {
    const m = newMatch();
    for (const multiplier of [1, 1.5, 2, 2.5]) {
      arm(m, 20);
      expect(field(m, 20).nextMultiplier).toBe(multiplier);
      const events = m.apply(throwCmd('20'));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value: -20 * multiplier })]));
      expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: multiplier + 0.5, nextMultiplier: null });
      if (m.view.awaitingTakeout) m.apply({ type: 'ADVANCE_TURN' });
    }
  });

  it('rounds each odd-number and bull penalty to whole points, with halves up', () => {
    for (const number of [19, 25]) {
      const m = newMatch();
      arm(m, number);
      play(m, String(number)); // 1x blast, reset to 1.5x
      arm(m, number);
      const events = m.apply(throwCmd(number === 25 ? '25' : '19'));
      const expected = number === 25 ? -38 : -29;
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value: expected })]));
      expect(m.view.turn.throws.at(-1)!.value).toBe(expected);
      expect(m.view.players.every((p) => Number.isInteger(p.score))).toBe(true);
      expect(m.allEvents.filter((e) => e.type === 'throw.recorded').every((e) => Number.isInteger(e.value))).toBe(true);
    }
  });

  it('shares both bull rings and leaves HP and multipliers unchanged on misses', () => {
    const m = newMatch();
    play(m, '25', 'BULL', '25', 'BULL', '25', 'BULL');
    expect(scoreOf(m, 'alice')).toBe(100);
    expect(scoreOf(m, 'bob')).toBe(125);
    expect(field(m, 25).hp).toBe(0);
    m.apply(throwCmd('MISS'));
    expect(field(m, 25)).toMatchObject({ hp: 0, multiplier: 1 });
    m.apply(throwCmd('25'));
    expect(m.view.turn.throws.at(-1)!.value).toBe(-25);
    expect(field(m, 25)).toMatchObject({ hp: 6, multiplier: 1.5 });
  });

  it('wins immediately when a safe dart reaches or crosses the target', () => {
    const m = newMatch({ targetScore: 70 });
    m.apply(throwCmd('T20'));
    m.apply(throwCmd('T19'));
    expect(scoreOf(m, 'alice')).toBe(117);
    expect(m.view.winnerId).toBe('alice');
    expect(m.view.status).toBe('finished');
  });

  it('resets scores and the field for a new set and rotates its starter', () => {
    const m = newMatch({ targetScore: 20, legsToWin: 1, setsToWin: 2 });
    m.apply(throwCmd('20'));
    expect(m.view.set).toBe(2);
    expect(m.view.activePlayerId).toBe('bob');
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply({ type: 'NEXT_PLAYER' });
    m.apply(throwCmd('20'));
    expect(m.view.winnerId).toBe('alice');
  });

  it('honours the round limit after both full and manually ended turns', () => {
    for (const handover of ['NEXT_PLAYER', 'ADVANCE_TURN'] as const) {
      const m = newMatch({ roundLimit: 1 });
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

  it('restarts scores, mines, multipliers and round counters', () => {
    const m = newMatch();
    arm(m, 20);
    play(m, '20');
    expect(field(m, 20).multiplier).toBe(1.5);
    expect(m.view.round).toBe(2);
    m.apply({ type: 'RESTART_LEG' });
    expect(m.view.round).toBe(1);
    expect(m.view.activePlayerId).toBe('alice');
    expect(m.view.turn.throws).toEqual([]);
    expect(m.view.players.map((p) => p.score)).toEqual([0, 0]);
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
  });

  it('replays a corrected arming dart and undo without inventing an explosion', () => {
    const m = newMatch();
    arm(m, 20);
    const armingId = m.view.recent.at(-1)!.id;
    m.apply(throwCmd('20'));
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    m.apply({ type: 'CORRECT_THROW', throwId: armingId, segment: seg('19') });
    expect(field(m, 20)).toMatchObject({ hp: 0, multiplier: 1 });
    expect(m.view.turn.throws.at(-1)!.value).toBe(20);
    m.apply({ type: 'UNDO' });
    expect(field(m, 20)).toMatchObject({ hp: 1, multiplier: 1 });
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
  });

  it('undoes an explosion and restores the armed mine with its previous multiplier', () => {
    const m = newMatch();
    arm(m, 20);
    m.apply(throwCmd('20'));
    m.apply({ type: 'UNDO' });
    expect(field(m, 20)).toMatchObject({ hp: 0, multiplier: 1, nextMultiplier: 1 });
    expect(scoreOf(m, 'alice')).toBe(60);
  });

  it('keeps HP stable through roster changes until the next leg', () => {
    const m = newMatch();
    arm(m, 20);
    m.apply({ type: 'ADD_PLAYER', player: players('Cara')[0]! });
    expect(scoreOf(m, 'cara')).toBe(0);
    m.apply(throwCmd('20'));
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    m.apply({ type: 'RESTART_LEG' });
    expect(field(m, 20)).toMatchObject({ hp: 9, multiplier: 1 });
    m.apply(throwCmd('20'));
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'bob' });
    expect(m.view.turn.total).toBe(20);
    expect(m.view.turn.throws[0]!.value).toBe(20);
    expect(field(m, 20).hp).toBe(8);
    m.apply({ type: 'RESTART_LEG' });
    expect(field(m, 20).hp).toBe(6);
  });

  it('ends early using the highest score', () => {
    const m = newMatch();
    play(m, '20', 'MISS', 'MISS', '19', 'MISS', 'MISS');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });
});

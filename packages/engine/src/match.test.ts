import { describe, it, expect, beforeEach } from 'vitest';
import { seg } from './testkit.ts';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'x01',
    startScore: 501,
    outMode: 'double',
    legsToWin: 1,
    setsToWin: 1,
  });
  m.apply({ type: 'START' });
  return m;
}

beforeEach(resetDartIds);

describe('undo', () => {
  it('removes the most recent dart', () => {
    const m = newMatch();
    play(m, 'T20', 'T20');
    expect(scoreOf(m, ALICE)).toBe(381);
    m.apply({ type: 'UNDO' });
    expect(scoreOf(m, ALICE)).toBe(441);
    expect(m.view.turn.throws).toHaveLength(1);
  });

  it('steps back across a turn boundary and restores the thrower', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    expect(m.view.activePlayerId).toBe(BOB);
    m.apply({ type: 'UNDO' });
    expect(m.view.activePlayerId).toBe(ALICE);
    expect(scoreOf(m, ALICE)).toBe(381);
    expect(m.view.turn.throws).toHaveLength(2);
  });

  it('reverses a bust, which is the case that matters after a misdetection', () => {
    const m = new Match('m2', players('Alice', 'Bob'), {
      gameType: 'x01',
      startScore: 41,
      outMode: 'double',
      legsToWin: 1,
      setsToWin: 1,
    });
    m.apply({ type: 'START' });
    play(m, '20');
    play(m, 'T20');                      // bust, back to 41, handover
    expect(scoreOf(m, ALICE)).toBe(41);
    expect(m.view.activePlayerId).toBe(BOB);
    m.apply({ type: 'UNDO' });
    expect(m.view.activePlayerId).toBe(ALICE);
    expect(scoreOf(m, ALICE)).toBe(21);  // the bust is fully unwound
  });

  it('reverses a leg win', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, 'T20', 'T20', 'T20');
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, 'T20', 'T19', 'D12');        // 141 checkout -> leg won
    expect(m.view.winnerId).toBe(ALICE);
    m.apply({ type: 'UNDO' });
    expect(m.view.winnerId).toBeNull();
    expect(m.view.status).toBe('playing');
  });

  it('is a no-op when nothing has been thrown', () => {
    const m = newMatch();
    expect(() => m.apply({ type: 'UNDO' })).not.toThrow();
    expect(scoreOf(m, ALICE)).toBe(501);
  });

  it('can be applied repeatedly', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    m.apply({ type: 'UNDO' });
    m.apply({ type: 'UNDO' });
    m.apply({ type: 'UNDO' });
    expect(scoreOf(m, ALICE)).toBe(501);
    expect(m.view.turn.throws).toHaveLength(0);
  });
});

describe('correction', () => {
  it('rescores a corrected dart in the current turn', () => {
    const m = newMatch();
    play(m, 'T20', 'T20');
    const first = m.view.turn.throws[0]!;
    m.apply({ type: 'CORRECT_THROW', throwId: first.id, segment: seg('T19') });
    expect(scoreOf(m, ALICE)).toBe(501 - 57 - 60);
  });

  it('can turn a bust into a valid score', () => {
    const m = new Match('m3', players('Alice', 'Bob'), {
      gameType: 'x01',
      startScore: 60,
      outMode: 'double',
      legsToWin: 1,
      setsToWin: 1,
    });
    m.apply({ type: 'START' });
    play(m, 'T20');                       // reaches 0 on a triple -> bust
    expect(scoreOf(m, ALICE)).toBe(60);
    expect(m.view.activePlayerId).toBe(BOB);   // wrongly handed over
    // The dart has already left the current turn, so it must be addressed by id.
    const misread = m.view.recent.at(-1)!;
    expect(misread.playerId).toBe(ALICE);
    m.apply({ type: 'CORRECT_THROW', throwId: misread.id, segment: seg('D15') });
    expect(scoreOf(m, ALICE)).toBe(30);
    expect(m.view.activePlayerId).toBe(ALICE);  // and the handover is undone
  });

  it('ignores an unknown throw id', () => {
    const m = newMatch();
    play(m, 'T20');
    m.apply({ type: 'CORRECT_THROW', throwId: 'nope', segment: seg('T19') });
    expect(scoreOf(m, ALICE)).toBe(441);
  });

  it('attributes recent throws to the player who threw them', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    play(m, '19');
    const recent = m.view.recent;
    expect(recent.at(-1)).toMatchObject({ label: 'S19', playerId: BOB });
    expect(recent.at(-2)).toMatchObject({ label: 'T20', playerId: ALICE });
  });
});

describe('command log', () => {
  it('records every applied command', () => {
    const m = newMatch();
    play(m, 'T20', 'T20');
    expect(m.log).toHaveLength(3);   // START + 2 throws
  });

  it('rebuilds identical state from its log', () => {
    const m = newMatch();
    play(m, 'T20', 'T19', 'D12', 'MISS', '5', '1');
    const rebuilt = Match.fromLog('m1', players('Alice', 'Bob'), m.config, [...m.log]);
    expect(rebuilt.view).toEqual(m.view);
  });

  it('rebuilds correctly after an undo', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    m.apply({ type: 'UNDO' });
    const rebuilt = Match.fromLog('m1', players('Alice', 'Bob'), m.config, [...m.log]);
    expect(rebuilt.view).toEqual(m.view);
  });

  it('recomputes value from segment, ignoring a wrong value on the wire', () => {
    const m = newMatch();
    m.apply({
      type: 'THROW',
      throw: {
        id: 'x', ts: '2026-01-01T00:00:00.000Z',
        segment: seg('T20'),
        value: 7,               // deliberately wrong
        coords: null, source: 'board',
      },
    });
    expect(scoreOf(m, ALICE)).toBe(441);
  });
});

describe('coordinate independence', () => {
  it('plays a full leg with every throw carrying null coords', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    expect(m.log.every((c) => c.type !== 'THROW' || c.throw.coords === null)).toBe(true);
    expect(scoreOf(m, ALICE)).toBe(321);
  });
});

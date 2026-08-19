import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'cricket',
    variant: 'standard',
    legsToWin: 1,
    setsToWin: 1,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

function marksOf(m: Match, playerId: string, target: number): number {
  const p = m.view.players.find((x) => x.playerId === playerId);
  const marks = p?.detail.marks as Record<number, number> | undefined;
  return marks?.[target] ?? 0;
}

beforeEach(resetDartIds);

describe('Cricket marks', () => {
  it('counts singles, doubles and triples as 1, 2 and 3 marks', () => {
    const m = newMatch();
    play(m, '20');
    expect(marksOf(m, ALICE, 20)).toBe(1);
    play(m, 'D20');
    expect(marksOf(m, ALICE, 20)).toBe(3);
  });

  it('closes a number with a single triple', () => {
    const m = newMatch();
    play(m, 'T19');
    expect(marksOf(m, ALICE, 19)).toBe(3);
  });

  it('caps marks at three', () => {
    const m = newMatch();
    play(m, 'T20', 'T20');
    expect(marksOf(m, ALICE, 20)).toBe(3);
  });

  it('ignores numbers outside the cricket set', () => {
    const m = newMatch();
    play(m, 'T14');
    expect(marksOf(m, ALICE, 14)).toBe(0);
    expect(scoreOf(m, ALICE)).toBe(0);
  });

  it('treats the outer bull as one mark and the inner as two', () => {
    const m = newMatch();
    play(m, '25');
    expect(marksOf(m, ALICE, 25)).toBe(1);
    play(m, 'BULL');
    expect(marksOf(m, ALICE, 25)).toBe(3);
  });
});

describe('Cricket standard scoring', () => {
  it('does not score while the number is still being closed', () => {
    const m = newMatch();
    play(m, 'T20');
    expect(scoreOf(m, ALICE)).toBe(0);
  });

  it('scores overflow marks once closed', () => {
    const m = newMatch();
    play(m, 'T20', 'T20');   // 3 marks close it, 3 overflow -> 60
    expect(scoreOf(m, ALICE)).toBe(60);
  });

  it('scores partial overflow correctly', () => {
    const m = newMatch();
    play(m, 'D20', 'D20');   // 2 marks, then 1 closes + 1 overflow -> 20
    expect(scoreOf(m, ALICE)).toBe(20);
  });

  it('stops scoring once every player has closed the number', () => {
    const m = newMatch();
    play(m, 'T20', 'MISS', 'MISS');
    play(m, 'T20', 'MISS', 'MISS');   // Bob closes 20 too
    play(m, 'T20');                   // Alice: nobody left with 20 open
    expect(scoreOf(m, ALICE)).toBe(0);
  });

  it('scores bull at 25 a mark', () => {
    const m = newMatch();
    play(m, 'BULL', 'BULL');   // 2 marks, then 1 to close + 1 overflow -> 25
    expect(scoreOf(m, ALICE)).toBe(25);
  });
});

describe('Cricket cut-throat scoring', () => {
  it('gives points to opponents rather than the thrower', () => {
    const m = newMatch({ variant: 'cutthroat' });
    play(m, 'T20', 'T20');
    expect(scoreOf(m, ALICE)).toBe(0);
    expect(scoreOf(m, BOB)).toBe(60);
  });

  it('skips opponents who have already closed the number', () => {
    const m = newMatch({ variant: 'cutthroat', targets: [20, 19] });
    play(m, 'T20', 'MISS', 'MISS');   // Alice closes 20
    play(m, 'T20', 'MISS', 'MISS');   // Bob closes 20
    play(m, 'T20');                   // no one open -> no points anywhere
    expect(scoreOf(m, BOB)).toBe(0);
    expect(scoreOf(m, ALICE)).toBe(0);
  });
});

describe('Cricket winning', () => {
  it('needs every target closed', () => {
    const m = newMatch({ targets: [20, 19] });
    play(m, 'T20', 'MISS', 'MISS');
    expect(m.view.winnerId).toBeNull();
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, 'T19');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('withholds the win while behind on points in standard play', () => {
    const m = newMatch({ targets: [20, 19] });
    // Bob closes 19 and racks up points first.
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, 'T19', 'T19', 'T19');       // Bob: 19 closed, 6 overflow -> 114
    expect(scoreOf(m, BOB)).toBe(114);
    play(m, 'T20', 'T19', 'MISS');      // Alice closes both but has 0 points
    expect(m.view.winnerId).toBeNull();
  });

  it('awards the win in cut-throat to the lowest score', () => {
    const m = newMatch({ variant: 'cutthroat', targets: [20, 19] });
    play(m, 'T20', 'T20', 'T19');       // Alice closes 20 and 19; Bob gets 60
    expect(scoreOf(m, BOB)).toBe(60);
    expect(m.view.winnerId).toBe(ALICE);
  });
});

describe('Cricket marks per round', () => {
  function mprOf(m: Match, playerId: string): number | null | undefined {
    return m.view.players.find((p) => p.playerId === playerId)?.stats.mpr;
  }

  it('reports nothing until a full round has been thrown', () => {
    const m = newMatch();
    play(m, 'T20');
    // Dividing 3 marks by a third of a round would read as 9.00, which is
    // meaningless -- MPR only means something over completed rounds.
    expect(mprOf(m, ALICE)).toBeNull();
  });

  it('reports the round average once a round completes', () => {
    const m = newMatch();
    play(m, 'T20', 'T19', 'T18');   // 9 marks in one round
    expect(mprOf(m, ALICE)).toBeCloseTo(9);
  });

  it('stays stable while the next turn is in progress', () => {
    const m = newMatch();
    play(m, 'T20', 'T19', 'T18');   // Alice: 9 marks, 1 round
    play(m, 'MISS', 'MISS', 'MISS');// Bob
    play(m, 'T17');                 // Alice mid-turn
    // Still 9.00 -- the in-progress turn does not distort it.
    expect(mprOf(m, ALICE)).toBeCloseTo(9);
  });

  it('averages across completed rounds', () => {
    const m = newMatch();
    play(m, 'T20', 'T19', 'T18');   // 9 marks
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, '17', '16', '15');      // 3 marks -> (9+3)/2 = 6
    expect(mprOf(m, ALICE)).toBeCloseTo(6);
  });

  it('counts a partial turn once it is ended early', () => {
    const m = newMatch();
    play(m, 'T20');
    m.apply({ type: 'NEXT_PLAYER' });
    expect(mprOf(m, ALICE)).toBeCloseTo(3);
  });
});

describe('Cricket roster changes', () => {
  it('lets a player join mid-match with a clean slate', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    m.apply({
      type: 'ADD_PLAYER',
      player: { id: 'carol', name: 'Carol', color: '#0f0' },
    });
    const carol = m.view.players.find((p) => p.playerId === 'carol');
    expect(carol).toBeDefined();
    expect(carol?.score).toBe(0);
    expect((carol?.detail.marks as Record<number, number>)[20]).toBe(0);
  });

  it('removes a player and keeps turn order intact', () => {
    const m = newMatch();
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    expect(m.view.players).toHaveLength(3);
    m.apply({ type: 'REMOVE_PLAYER', playerId: BOB });
    expect(m.view.players.map((p) => p.playerId)).toEqual([ALICE, 'carol']);
    expect(m.view.activePlayerId).toBe(ALICE);
  });
});

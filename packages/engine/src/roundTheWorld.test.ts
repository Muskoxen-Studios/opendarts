import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf } from './testkit.ts';
beforeEach(resetDartIds);
const start = (cfg: Record<string, unknown> = {}, solo = false) => { const m = new Match('world', solo ? players('Alice') : players('Alice', 'Bob'), { gameType: 'roundtheworld', seed: 42, ...cfg }); m.apply({ type: 'START' }); return m; };
describe('Round the World', () => {
  it('scores ring marks, not board points, and keeps a shared target until everyone throws', () => {
    const m = start({ order: 'descending' }); play(m, 'S20', 'D20', 'T20');
    expect(scoreOf(m, 'alice')).toBe(6); expect(m.view.players[1]?.detail.target).toBe(20);
    play(m, 'MISS', 'S1', 'BULL'); expect(m.view.players[0]?.detail.target).toBe(19);
  });
  it('advances after three misses and after an explicitly shortened turn', () => {
    const m = start({}, true); play(m, 'MISS', 'MISS', 'MISS');
    expect(m.view.turn.hints).toEqual(['2', '2', '2']);
    m.apply({ type: 'NEXT_PLAYER' }); expect(m.view.players[0]?.detail.target).toBe(3);
  });
  it('finishes after all 21 visits, with outer/inner bull worth 1/2 marks', () => {
    const m = start({}, true); for (let i = 0; i < 20; i++) play(m, 'MISS', 'MISS', 'MISS');
    expect(m.finished).toBe(false); play(m, '25', 'BULL', 'S20');
    expect(m.view.winnerId).toBe('alice'); expect(scoreOf(m, 'alice')).toBe(3);
  });
  it('supports no bull, round limits, legs and replay-safe random order', () => {
    const m = start({ order: 'random', finishBull: false, roundLimit: 1, legsToWin: 2 });
    const target = Number(m.view.players[0]?.detail.target);
    expect((m.view.players[0]?.detail.sequence as number[]).slice().sort((a,b)=>a-b)).toEqual(Array.from({length:20},(_,i)=>i+1));
    play(m, `T${target}`, 'MISS', 'MISS', 'MISS', 'MISS', 'MISS');
    expect(m.view.leg).toBe(2); expect(m.view.players[0]?.legsWon).toBe(1);
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
    m.apply({type:'UNDO'}); expect(Match.fromLog(m.matchId,m.players,m.config,[...m.log]).view).toEqual(m.view);
  });
  it('awards the highest marks at the natural end after every player has played', () => {
    const m = start({finishBull:false});
    for(let n=1;n<=20;n++){play(m,'MISS','MISS','MISS'); play(m,`S${n}`,'MISS','MISS');}
    expect(m.view.winnerId).toBe('bob');
  });
});

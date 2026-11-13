import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';
beforeEach(resetDartIds);
const start=(cfg:Record<string,unknown>={})=>{const m=new Match('bob',players('Alice'),{gameType:'bobs27',...cfg});m.apply({type:'START'});return m;};
describe("Bob's 27",()=>{
  it('starts at 27, adds each correct double, and subtracts once for a blank visit',()=>{
    const m=start();play(m,'D1','D1','S1');expect(scoreOf(m,'alice')).toBe(31);
    play(m,'MISS','D1','T2');expect(scoreOf(m,'alice')).toBe(27);
    expect(m.view.turn.hints).toEqual(['D3','D3','D3']);
  });
  it('ends without a win when normal mode drops below zero',()=>{
    const m=start();play(m,...Array<string>(15).fill('MISS'));
    expect(scoreOf(m,'alice')).toBe(-3);expect(m.view).toMatchObject({status:'finished',winnerId:null});
    expect(m.allEvents.some(e=>e.type==='match.won')).toBe(false);
  });
  it('continues through negative scores when enabled and supports the final inner bull',()=>{
    const m=start({allowNegative:true});play(m,...Array<string>(60).fill('MISS'));
    expect(m.finished).toBe(false);expect(m.view.turn.hints).toEqual(['BULL','BULL','BULL']);
    const before=scoreOf(m,'alice');play(m,'25','BULL','BULL');expect(scoreOf(m,'alice')).toBe(before+100);expect(m.finished).toBe(true);
    expect(m.view.winnerId).toBeNull();
  });
  it('finishes a successful 20-target run and supports sets',()=>{
    const m=start({finishBull:false,setsToWin:2});
    for(let n=1;n<=20;n++)play(m,`D${n}`,'MISS','MISS');
    expect(m.view).toMatchObject({status:'playing',set:2});expect(scoreOf(m,'alice')).toBe(27);
  });
  it('is solo-only, rejects late joins and reverses a penalty on undo',()=>{
    expect(()=>new Match('invalid',players('Alice','Bob'),{gameType:'bobs27'})).toThrow('exactly one');
    const m=start();expect(m.apply({type:'ADD_PLAYER',player:players('Bob')[0]!})).toEqual([]);
    for(let i=0;i<3;i++)m.apply(throwCmd('MISS'));
    expect(scoreOf(m,'alice')).toBe(25);m.apply({type:'UNDO'});expect(scoreOf(m,'alice')).toBe(27);
  });
  it('applies a penalty on an explicitly ended empty visit and can restart it',()=>{
    const m=start();m.apply({type:'NEXT_PLAYER'});expect(scoreOf(m,'alice')).toBe(25);
    m.apply({type:'RESTART_LEG'});expect(scoreOf(m,'alice')).toBe(27);expect(m.view.round).toBe(1);
  });
});

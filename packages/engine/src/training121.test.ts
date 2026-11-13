import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { suggestCheckout } from './checkout.ts';
import { play, players, resetDartIds, throwCmd } from './testkit.ts';
beforeEach(resetDartIds);
const start=(cfg:Record<string,unknown>={})=>{const m=new Match('121',players('Alice'),{gameType:'121',...cfg});m.apply({type:'START'});return m;};
const level=(m:Match)=>Number(m.view.players[0]?.detail.level);
function finishLevel(m:Match):void{
  let route=suggestCheckout(m.view.players[0]!.score,3,'double');
  if(!route){play(m,'S20');m.apply({type:'NEXT_PLAYER'});route=suggestCheckout(m.view.players[0]!.score,3,'double');}
  if(!route)throw Error('no route');play(m,...route);
}
describe('121',()=>{
  it('starts at 121 with nine darts per attempt and raises the target after double-out',()=>{
    const m=start();expect(m.config).toMatchObject({maxRounds:10,dartMode:9,step:1,onFail:'soft'});
    play(m,'T20','T19','D2');expect(level(m)).toBe(122);expect(m.view.players[0]?.score).toBe(122);
    expect(m.view.players[0]?.detail).toMatchObject({attempts:1,checkouts:1,highest:122});
  });
  it('preserves remaining score between visits but restores a busted visit',()=>{
    const m=start();play(m,'S20','S20','S20');expect(m.view.players[0]?.score).toBe(61);
    m.apply(throwCmd('T20'));m.apply(throwCmd('S1'));expect(m.view.players[0]?.score).toBe(61);
    expect(m.view.awaitingTakeout).toBe(true);expect(m.view.players[0]?.detail.turnsUsed).toBe(2);
  });
  it('uses six-dart attempts and records no win when everyone finishes on 121',()=>{
    const m=start({dartMode:6,maxRounds:1});play(m,...Array<string>(6).fill('MISS'));
    expect(m.view).toMatchObject({status:'finished',winnerId:null});
  });
  it('soft failure drops one, independently of the success step',()=>{
    const m=start({step:3});finishLevel(m);expect(level(m)).toBe(124);
    play(m,...Array<string>(9).fill('MISS'));expect(level(m)).toBe(123);
  });
  it('hard failure resets to 121',()=>{
    const m=start({step:5,onFail:'hard'});finishLevel(m);expect(level(m)).toBe(126);
    play(m,...Array<string>(9).fill('MISS'));expect(level(m)).toBe(121);
  });
  it('banks safehouses only at the configured successful-checkout interval',()=>{
    const m=start({onFail:'safehouse',safehouseEvery:2,step:3});finishLevel(m);
    play(m,...Array<string>(9).fill('MISS'));expect(level(m)).toBe(121);
    finishLevel(m);expect(m.view.players[0]?.detail.safehouse).toBe(124);
    play(m,...Array<string>(9).fill('MISS'));expect(level(m)).toBe(124);
  });
  it('checks out 170 to win immediately and clamps a step that would exceed it',()=>{
    const m=start({step:5,maxRounds:30});
    for(let i=0;i<10;i++)finishLevel(m);
    expect(level(m)).toBe(170);expect(m.finished).toBe(false);finishLevel(m);
    expect(m.view.winnerId).toBe('alice');
  });
  it('ranks final level at the attempt limit and supports undo/correction',()=>{
    const m=start({maxRounds:1});play(m,'T20','T19','D2');expect(m.view.winnerId).toBe('alice');
    const last=m.log.filter(c=>c.type==='THROW').at(-1);if(last?.type!=='THROW')throw Error('throw');
    m.apply({type:'CORRECT_THROW',throwId:last.throw.id,segment:{number:0,ring:'MISS'}});
    expect(m.finished).toBe(false);expect(level(m)).toBe(121);m.apply({type:'UNDO'});
    expect(Match.fromLog(m.matchId,m.players,m.config,[...m.log]).view).toEqual(m.view);
  });
});

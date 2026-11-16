import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';
beforeEach(resetDartIds);
const start=(cfg:Record<string,unknown>={},solo=false)=>{const m=new Match('random-checkout',solo?players('Alice'):players('Alice','Bob'),{gameType:'randomcheckout',seed:42,checkoutMin:20,checkoutMax:20,...cfg});m.apply({type:'START'});return m;};
describe('Random Checkout',()=>{
  it('gives the same target to everyone and reproduces it from persisted seed',()=>{
    const m=start({checkoutMin:41,checkoutMax:100});expect(m.view.players[0]?.score).toBe(m.view.players[1]?.score);
    expect(scoreOf(m,'alice')).toBeGreaterThanOrEqual(41);expect(scoreOf(m,'alice')).toBeLessThanOrEqual(100);
    expect(Match.fromLog(m.matchId,m.players,m.config,[...m.log]).view).toEqual(m.view);
  });
  it('requires double out by default, restores the entire visit on bust, and shows a legal route',()=>{
    const m=start();expect(m.view.turn.hints).toEqual(['D10']);
    m.apply(throwCmd('S5'));m.apply(throwCmd('S14'));
    expect(scoreOf(m,'alice')).toBe(20);expect(m.view.awaitingTakeout).toBe(true);
    expect(m.allEvents.filter(e=>e.type==='turn.completed').at(-1)).toMatchObject({total:0,busted:true});
  });
  it.each(['straight','master'])('supports %s out',outMode=>{
    const m=start({outMode,checkoutMin:60,checkoutMax:60,continuous:false});play(m,outMode==='master'?'T20':'S20');
    if(outMode==='straight')play(m,'S20','S20');
    expect(m.view.winnerId).toBe('alice');
  });
  it('awards no leg if everyone exhausts the budget in finite mode',()=>{
    const m=start({continuous:false,maxRounds:1});play(m,...Array<string>(6).fill('MISS'));
    expect(m.view).toMatchObject({status:'finished',winnerId:null});expect(m.view.players.map(p=>p.legsWon)).toEqual([0,0]);
  });
  it('continuous failed legs start a new target after takeout, without inventing wins',()=>{
    const m=start({maxRounds:1},true);play(m,'MISS','MISS','MISS');
    expect(m.view).toMatchObject({status:'playing',leg:2});expect(m.view.players[0]?.legsWon).toBe(0);
    m.apply({type:'END_MATCH'});expect(m.view.winnerId).toBeNull();
  });
  it('continuous checkouts bank legs and End game compares successful legs',()=>{
    const m=start();play(m,'D10');expect(m.view.leg).toBe(2);expect(m.view.players[0]?.legsWon).toBe(1);
    m.apply({type:'END_MATCH'});expect(m.view.winnerId).toBe('alice');
  });
  it('never awards an unchecked-out leg when a round cap ends it', () => {
    const m = start({ roundLimit: 1 }, true);
    play(m, 'D10');
    play(m, 'MISS', 'MISS', 'MISS');
    expect(m.view).toMatchObject({ status: 'playing', leg: 3 });
    expect(m.view.players[0]?.legsWon).toBe(1);
    expect(m.allEvents.filter(e => e.type === 'leg.won')).toHaveLength(1);
  });
  it('rejects inverted score ranges and undoes a checkout across the next leg',()=>{
    expect(()=>start({checkoutMin:100,checkoutMax:40})).toThrow();
    const m=start();play(m,'D10');m.apply({type:'UNDO'});expect(m.view.leg).toBe(1);expect(scoreOf(m,'alice')).toBe(20);
  });
});

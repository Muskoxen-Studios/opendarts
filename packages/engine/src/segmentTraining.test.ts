import { beforeEach, describe, expect, it } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';
beforeEach(resetDartIds);
const start = (cfg:Record<string,unknown>={}) => {const m=new Match('segment',players('Alice','Bob'),{gameType:'segmenttraining',seed:42,...cfg});m.apply({type:'START'});return m;};
describe('Segment Training',()=>{
  it('hits only the selected zone and finishes immediately on the hit goal',()=>{
    const m=start({mode:'double',segment:16,count:1});play(m,'S16','T16','D16');
    expect(m.view.winnerId).toBe('alice');expect(scoreOf(m,'alice')).toBe(1);
  });
  it('accepts either single in Single mode but only outer singles in Outer Single mode',()=>{
    for(const mode of ['single','outer-single']){
      const m=start({mode,count:1});const cmd=throwCmd('S20');if(cmd.type!=='THROW')throw Error('throw');
      cmd.throw.segment.ring='SINGLE_INNER';m.apply(cmd);
      expect(scoreOf(m,'alice')).toBe(mode==='single'?1:0);
    }
  });
  it('gives each player the exact dart budget, even when not divisible by three',()=>{
    const m=start({mode:'triple',count:2,endsAfter:'darts'});
    play(m,'T20','MISS');expect(m.view.activePlayerId).toBe('bob');expect(m.finished).toBe(false);
    play(m,'T20','T20');expect(m.view.winnerId).toBe('bob');
    expect(m.allEvents.filter(e=>e.type==='throw.recorded')).toHaveLength(4);
  });
  it('keeps random targets stable on misses and reproduces the random path on replay/correction',()=>{
    const m=start({mode:'random',count:3});const first=m.view.turn.hints[0]!;
    play(m,'MISS');expect(m.view.turn.hints[0]).toBe(first);play(m,first);
    expect(scoreOf(m,'alice')).toBe(1);
    expect(Match.fromLog(m.matchId,m.players,m.config,[...m.log]).view).toEqual(m.view);
    m.apply({type:'UNDO'});expect(m.view.turn.hints[0]).toBe(first);
  });
  it('records zero for wrong numbers, restarts and honours round limits',()=>{
    const m=start({mode:'single',segment:7,roundLimit:1});play(m,'S7','MISS','MISS','S20','MISS','MISS');
    expect(m.view.winnerId).toBe('alice');
    const restarted=start();play(restarted,'S20');restarted.apply({type:'RESTART_LEG'});expect(scoreOf(restarted,'alice')).toBe(0);
  });
});

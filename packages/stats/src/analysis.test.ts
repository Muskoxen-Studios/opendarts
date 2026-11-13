import { describe, expect, it } from 'vitest';
import { GameConfigSchema, type MatchCommand } from '@darts/schema';
import { Match, GAME_TYPES } from '@darts/engine';
import { dart, players } from '../../engine/src/testkit.ts';
import { analyzeMatch, MatchAnalyzer, type MatchRecord } from './analysis.ts';

describe('incremental match analysis', () => {
  it.each(GAME_TYPES)('matches corrected-log replay for %s through turns, undo, correction and restart', (gameType) => {
    const roster = gameType === 'bobs27' ? players('Alice') : players('Alice', 'Bob', 'Cara', 'Dan');
    const config = GameConfigSchema.parse({ gameType });
    const m = new Match('incremental', roster, config);
    const record: MatchRecord = { matchId: m.matchId, gameType, config, players: roster,
      commands: [], endedAt: null };
    const analyzer = new MatchAnalyzer(record);
    const apply = (cmd: MatchCommand) => {
      m.apply(cmd);
      analyzer.append(cmd);
      expect(analyzer.analysis).toEqual(analyzeMatch({ ...record, commands: [...m.log] }));
    };
    apply({ type: 'START' });
    for (const label of ['T20', 'T20', 'T20', 'S1', 'D1', 'MISS', 'T19', '25', 'BULL', 'D16']) {
      apply({ type: 'THROW', throw: dart(label) });
      if (m.view.awaitingTakeout) apply({ type: 'ADVANCE_TURN' });
    }
    apply({ type: 'UNDO' });
    const first = m.log.find((c) => c.type === 'THROW');
    if (first?.type !== 'THROW') throw new Error('missing first dart');
    apply({ type: 'CORRECT_THROW', throwId: first.throw.id, segment: { number: 0, ring: 'MISS' } });
    apply({ type: 'NEXT_PLAYER' });
    apply({ type: 'THROW', throw: dart('T20') });
    apply({ type: 'RESTART_LEG' });
    apply({ type: 'THROW', throw: dart('S5') });
    apply({ type: 'ADD_PLAYER', player: players('Eve')[0]! });
    apply({ type: 'REMOVE_PLAYER', playerId: 'dan' });
    apply({ type: 'END_MATCH' });
  });
});

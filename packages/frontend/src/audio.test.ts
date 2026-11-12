import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchView } from '@darts/schema';
import { planAudio } from './audio.ts';

function view(patch: Partial<MatchView> = {}): MatchView {
  return {
    matchId: 'match', gameType: 'x01', status: 'playing', activePlayerId: 'alice',
    awaitingTakeout: false, leg: 1, set: 1, round: 1, roundLimit: null, winnerId: null,
    turn: { throws: [], total: 0, dartsRemaining: 3, hints: ['D20'] }, recent: [],
    players: [{ playerId: 'alice', name: 'Alice', color: '#fff', score: 40,
      isActive: true, legsWon: 0, setsWon: 0, checkout: ['D20'], detail: {},
      stats: { average3: null, dartsThrown: 0 } }], ...patch,
  };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function flushAudio(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('announcer decisions', () => {
  it('stays silent for a snapshot or reconnect', () => {
    expect(planAudio(null, view(), [])).toEqual({ words: [], cue: undefined });
  });
  it('calls a legal checkout at match start and after takeout, once per turn', () => {
    expect(planAudio(null, view(), [{ type: 'match.started' }]).words).toEqual(['You require 40.']);
    expect(planAudio(view({ awaitingTakeout: true }), view(), []).words).toEqual(['You require 40.']);
    expect(planAudio(view(), view(), []).words).toEqual([]);
  });
  it('does not guess checkouts from a score or announce during takeout', () => {
    const bogey = view();
    bogey.players[0]!.checkout = null;
    bogey.players[0]!.score = 169;
    expect(planAudio(null, bogey, [{ type: 'match.started' }]).words).toEqual([]);
    expect(planAudio(null, view({ awaitingTakeout: true }), [{ type: 'match.started' }]).words).toEqual([]);
    expect(planAudio(null, view({ gameType: 'gotcha' }), [{ type: 'match.started' }]).words).toEqual([]);
  });
  it('announces completed totals, including zero, rather than each dart', () => {
    expect(planAudio(view(), view(), [{ type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 60 }]).words).toEqual([]);
    for (const total of [0, 180]) {
      expect(planAudio(view(), view({ awaitingTakeout: true }), [
        { type: 'turn.completed', playerId: 'alice', total, darts: 3, busted: false },
      ]).words).toEqual([total === 0 ? 'No score.' : `${total}.`]);
    }
  });
  it('calls a bust instead of the zero-point completed turn', () => {
    expect(planAudio(view(), view({ awaitingTakeout: true }), [
      { type: 'player.busted', playerId: 'alice', reason: 'below zero' },
      { type: 'turn.completed', playerId: 'alice', total: 0, darts: 2, busted: true },
    ])).toEqual({ words: ['Bust.'], cue: 'bust' });
  });
  it('uses one winning call when checkout, leg, set and match events arrive together', () => {
    expect(planAudio(view(), view({ status: 'finished' }), [
      { type: 'x01.checkout', playerId: 'alice', score: 501, darts: 12 },
      { type: 'turn.completed', playerId: 'alice', total: 40, darts: 1, busted: false },
      { type: 'leg.won', playerId: 'alice', darts: 12 },
      { type: 'set.won', playerId: 'alice' }, { type: 'match.won', playerId: 'alice' },
    ])).toEqual({ words: ['Game shot. Match won.'], cue: 'win' });
  });
  it('does not call a checkout after undo or correction changes the active player', () => {
    const old = view({ activePlayerId: 'bob', recent: [{ id: 'dart', playerId: 'alice', label: 'S20', value: 20 }] });
    expect(planAudio(old, view(), []).words).toEqual([]);
    expect(planAudio(old, view({ recent: [{ id: 'dart', playerId: 'alice', label: 'S5', value: 5 }] }), []).words).toEqual([]);
  });
  it('calls Gotcha once instead of other sounds, including when a turn ends or multiple opponents are knocked back', () => {
    const next = view({ gameType: 'gotcha', recent: [{ id: 'dart', playerId: 'alice', label: 'S20', value: 20 }] });
    const knockedBack = { type: 'gotcha.knockback', byPlayerId: 'alice', victimPlayerId: 'bob', from: 40, to: 0 } as const;
    expect(planAudio(view(), next, [
      { type: 'throw.recorded', playerId: 'alice', dartIndex: 2, value: 20 },
      knockedBack, { ...knockedBack, victimPlayerId: 'carol' },
      { type: 'turn.completed', playerId: 'alice', total: 60, darts: 3, busted: false },
    ])).toEqual({ words: ['Gotcha!'], cue: undefined });
    expect(planAudio(view(), next, []).words).toEqual([]);
  });
  it('confirms registered non-miss throws, even with zero counted points, but excludes busts and snapshots', () => {
    const next = view({ recent: [{ id: 'dart', playerId: 'alice', label: 'S20', value: 20 }] });
    const recorded = { type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 0 } as const;
    expect(planAudio(view(), next, [recorded]).throwConfirmed).toBe(true);
    expect(planAudio(view(), next, []).throwConfirmed).toBeUndefined();
    expect(planAudio(view(), next, [recorded, { type: 'player.busted', playerId: 'alice', reason: 'below zero' }]).throwConfirmed).toBeUndefined();
    expect(planAudio(view(), next, [recorded, { type: 'turn.completed', playerId: 'alice', total: 0, darts: 1, busted: true }]).throwConfirmed).toBeUndefined();
    next.recent[0]!.label = 'MISS';
    expect(planAudio(view(), next, [recorded]).throwConfirmed).toBeUndefined();
  });
  it('announces a physical miss, including the last dart, without calling failed double-in a miss', () => {
    const next = view({ recent: [{ id: 'miss', playerId: 'alice', label: 'MISS', value: 0 }] });
    const dart = { type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 0 } as const;
    expect(planAudio(view(), next, [dart]).words).toEqual(['Miss.']);
    expect(planAudio(view(), next, [dart, { type: 'turn.completed', playerId: 'alice', total: 0, darts: 3, busted: false }]).words).toEqual(['Miss.', 'No score.']);
    expect(planAudio(view(), view({ recent: [{ id: 'single', playerId: 'alice', label: 'S20', value: 20 }] }), [dart]).words).toEqual([]);
  });
  it('plays one explosion for mine or blast-zone hits and chains, including alongside a bust', () => {
    for (const hazard of ['mine', 'blast'] as const) {
      const hit = { type: 'minefield.exploded', playerId: 'alice', number: 20, hazard, value: -20, resetsScore: false, segment: { number: 20, ring: 'SINGLE_OUTER' }, coords: null } as const;
      const next = view({ gameType: 'minefield', recent: [{ id: 'dart', playerId: 'alice', label: 'S20', value: 20 }] });
      expect(planAudio(view(), next, [hit, { ...hit, number: 5 }]).explosion).toBe(true);
      for (const total of [-20, 0, 40]) {
        expect(planAudio(view(), next, [hit,
          { type: 'throw.recorded', playerId: 'alice', dartIndex: 2, value: 20 },
          { type: 'turn.completed', playerId: 'alice', total, darts: 3, busted: false },
        ])).toEqual({ words: [], cue: undefined, explosion: true });
      }
      expect(planAudio(view(), next, [hit, { type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 20 }])).toEqual({ words: [], cue: undefined, explosion: true });
      expect(planAudio(view(), next, [hit, { type: 'player.busted', playerId: 'alice', reason: 'overshoot' }])).toMatchObject({ explosion: true, cue: 'bust', words: ['Bust.'] });
      expect(planAudio(view(), next, []).explosion).toBeUndefined();
      expect(planAudio(view(), next, [{ type: 'minefield.defused', playerId: 'alice', number: 20, segment: hit.segment, coords: null }]).explosion).toBeUndefined();
    }
  });
});

describe('Golf target announcements', () => {
  function golf(hole: number | null, patch: Partial<MatchView> = {}): MatchView {
    const next = view({ gameType: 'golf', ...patch });
    next.players[0]!.checkout = null;
    next.players[0]!.detail = { hole, holes: 18, done: hole === null };
    return next;
  }
  function completed(hole: number, holed: boolean) {
    return { type: 'golf.hole', playerId: 'alice', hole, strokes: holed ? 1 : 5, par: 4, points: holed ? 5 : 0, holed } as const;
  }
  it('calls the starting target but stays silent on snapshots and unchanged targets', () => {
    expect(planAudio(null, golf(1), [{ type: 'match.started' }]).words).toEqual(['Target 1.']);
    expect(planAudio(null, golf(1), []).words).toEqual([]);
    expect(planAudio(golf(1), golf(1), []).words).toEqual([]);
    expect(planAudio(golf(1), golf(1), [{ type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 0 }]).words).toEqual([]);
  });
  it('calls every next target after either a hit or the final missed scoring attempt', () => {
    for (let hole = 1; hole < 18; hole++) {
      for (const holed of [true, false]) {
        expect(planAudio(golf(hole), golf(hole + 1), [completed(hole, holed)]).words).toEqual([`Target ${hole + 1}.`]);
      }
    }
  });
  it('defers the new target after a third-dart miss until takeout, including solo play', () => {
    const next = golf(2, { awaitingTakeout: true, recent: [{ id: 'miss', playerId: 'alice', label: 'MISS', value: 0 }] });
    expect(planAudio(golf(1), next, [
      completed(1, false), { type: 'throw.recorded', playerId: 'alice', dartIndex: 2, value: 0 },
      { type: 'turn.completed', playerId: 'alice', total: 0, darts: 3, busted: false },
    ]).words).toEqual(['Miss.', 'No score.']);
    expect(planAudio(next, { ...next, awaitingTakeout: false }, []).words).toEqual(['Target 2.']);
  });
  it.each([1, 2, 5])('after a third-dart hit waits for handover to announce the incoming target %i', (incomingHole) => {
    const old = golf(1);
    const held = golf(2, {
      awaitingTakeout: true,
      turn: { throws: [], total: 3, dartsRemaining: 0, hints: [] },
      recent: [{ id: 'hit', playerId: 'alice', label: 'S1', value: 1 }],
    });
    const bob = { ...held.players[0]!, playerId: 'bob', name: 'Bob', isActive: false, detail: { hole: incomingHole, holes: 18 } };
    old.players.push(bob);
    held.players.push(bob);
    expect(planAudio(old, held, [
      completed(1, true), { type: 'throw.recorded', playerId: 'alice', dartIndex: 2, value: 3 },
      { type: 'turn.completed', playerId: 'alice', total: 3, darts: 3, busted: false },
    ]).words).toEqual(['3.']);
    const incoming = { ...held, activePlayerId: 'bob', awaitingTakeout: false,
      turn: { throws: [], total: 0, dartsRemaining: 3, hints: [] } };
    expect(planAudio(held, incoming, []).words).toEqual([`Target ${incomingHole}.`]);
    expect(planAudio(incoming, incoming, []).words).toEqual([]);
  });
  it('calls the incoming player’s actual hole when players are at different targets', () => {
    const old = golf(5, { awaitingTakeout: true });
    const next = golf(2);
    next.players[0]!.playerId = 'bob';
    next.activePlayerId = 'bob';
    expect(planAudio(old, next, []).words).toEqual(['Target 2.']);
  });
  it('does not invent a target beyond the final hole or announce corrections', () => {
    for (const holes of [9, 18]) {
      expect(planAudio(golf(holes), golf(null), [completed(holes, true)]).words).toEqual([]);
      expect(planAudio(golf(holes), golf(null, { status: 'finished' }), [completed(holes, true), { type: 'match.won', playerId: 'alice' }]).words).toEqual(['Game shot. Match won.']);
    }
    expect(planAudio(golf(2), golf(1), []).words).toEqual([]);
  });
});

describe('browser audio', () => {
  it('requires opt-in and a gesture, persists preferences, and cancels on mute', async () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      constructor(text: string) { this.text = text; }
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    const audio = await import('./audio.ts');
    audio.playAudio({ words: ['180'] });
    expect(speak).not.toHaveBeenCalled();
    audio.unlockAudio();
    audio.playAudio({ words: ['180'] });
    expect(speak).not.toHaveBeenCalled();
    audio.saveAudio({ voice: true, volume: 0.5 });
    audio.playAudio({ words: ['180'] });
    await flushAudio();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: '180', volume: 0.5, lang: 'en-GB' }));
    expect(setItem).toHaveBeenCalledWith('opendarts.audio', JSON.stringify({ voice: true, effects: false, volume: 0.5 }));
    audio.saveAudio({ voice: false });
    expect(cancel).toHaveBeenCalled();
    audio.playAudio({ words: ['40'] });
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('stays silent while hidden and waits for each utterance to finish even after rapid inputs', async () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      constructor(text: string) { this.text = text; }
    });
    vi.stubGlobal('localStorage', { getItem: () => '{"voice":true}', setItem: vi.fn() });
    vi.stubGlobal('document', { hidden: true });
    const audio = await import('./audio.ts');
    audio.unlockAudio();
    audio.playAudio({ words: ['hidden'] });
    expect(speak).not.toHaveBeenCalled();
    vi.stubGlobal('document', { hidden: false });
    for (let i = 0; i < 5; i++) audio.playAudio({ words: [String(i)] });
    await flushAudio();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) {
      expect(speak.mock.calls[i]![0].text).toBe(String(i));
      speak.mock.calls[i]![0].onend();
      await flushAudio();
      expect(speak).toHaveBeenCalledTimes(i + 2);
    }
    expect(speak).toHaveBeenCalledTimes(5);
    expect(cancel).not.toHaveBeenCalled();
    audio.playAudio({ words: ['after error'] });
    speak.mock.calls[4]![0].onerror();
    await flushAudio();
    expect(speak.mock.calls[5]![0].text).toBe('after error');
    audio.playAudio({ words: ['cancelled'] });
    audio.stopAudio();
    await flushAudio();
    expect(speak).toHaveBeenCalledTimes(6);
  });
  it('degrades safely with unavailable APIs and corrupt or blocked storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '{broken', setItem: () => { throw Error('blocked'); } });
    const audio = await import('./audio.ts');
    expect(audio.audioSettings.voice).toBe(false);
    expect(() => {
      audio.saveAudio({ voice: true, effects: true });
      audio.previewAudio();
      audio.stopAudio();
    }).not.toThrow();
  });
  it('plays generated effects at the selected volume and stops them on mute', async () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    const oscillators: Array<{ stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; frequency: { value: number } }> = [];
    const volumes: number[] = [];
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator() {
        const node = { start: vi.fn(), stop: vi.fn(), frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (gain: unknown) => gain };
        oscillators.push(node);
        return node;
      }
      createGain() {
        return { gain: { setValueAtTime: (volume: number) => volumes.push(volume), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
      }
    });
    vi.stubGlobal('localStorage', { getItem: () => '{"voice":true,"effects":true,"volume":0.5}', setItem: vi.fn() });
    const audio = await import('./audio.ts');
    audio.unlockAudio();
    audio.playAudio({ words: ['Game shot.'], cue: 'win' });
    await vi.advanceTimersByTimeAsync(999);
    expect(speak).not.toHaveBeenCalled();
    expect(oscillators).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(oscillators.map(o => o.frequency.value)).toEqual([30, 523, 659, 784]);
    expect(volumes).toEqual([0.0001, 0.09, 0.09, 0.09]);
    expect(speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(540);
    expect(speak).toHaveBeenCalledOnce();
    // Confirmation is a 75 ms dull knock, immediately audible even while speech is
    // still active. It must not wait for onend or restart the commentary.
    audio.playAudio({ words: [], throwConfirmed: true });
    expect(oscillators.map(o => o.frequency.value)).toEqual([30, 523, 659, 784, 220]);
    expect(oscillators.at(-1)!.start).toHaveBeenCalledWith(0);
    expect(oscillators.at(-1)!.stop).toHaveBeenCalledWith(0.075);
    expect(volumes.at(-1)).toBe(0.125);
    expect(speak).toHaveBeenCalledOnce();
    audio.saveAudio({ effects: false });
    for (const oscillator of oscillators) expect(oscillator.stop).toHaveBeenCalledTimes(2);
    audio.playAudio({ words: [], throwConfirmed: true });
    expect(oscillators).toHaveLength(5);
    audio.saveAudio({ effects: true, volume: 0 });
    audio.playAudio({ words: [], throwConfirmed: true });
    expect(oscillators).toHaveLength(5);
  });
  it.each(['bust', 'explosion'] as const)('plays a bounded %s buffer before speech, and stops it on mute', async (effect) => {
    vi.useFakeTimers();
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    const duration = effect === 'bust' ? 0.8 : 1;
    const waitMs = effect === 'bust' ? 900 : 1100;
    const samples = new Float32Array(24000 * duration);
    const buffer = { getChannelData: () => samples };
    const source = { buffer: null as unknown, connect: (gain: unknown) => gain, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
    const volume = vi.fn();
    const createBuffer = vi.fn(() => buffer);
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      currentTime = 0;
      sampleRate = 24000;
      destination = {};
      createBuffer = createBuffer;
      createBufferSource() { return source; }
      createOscillator() {
        return { frequency: { value: 0 }, connect: (gain: unknown) => gain, start: vi.fn(), stop: vi.fn() };
      }
      createGain() {
        return { gain: { setValueAtTime: volume, exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      }
    });
    vi.stubGlobal('localStorage', { getItem: () => '{"voice":true,"effects":true,"volume":0.5}', setItem: vi.fn() });
    const audio = await import('./audio.ts');
    audio.unlockAudio();
    const plan = effect === 'bust' ? { words: ['Bust.'], cue: 'bust' as const } : { words: ['No score.'], explosion: true };
    audio.playAudio(plan);
    await vi.advanceTimersByTimeAsync(1000);
    expect(createBuffer).toHaveBeenCalledWith(1, samples.length, 24000);
    expect(source.buffer).toBe(buffer);
    expect(source.start).toHaveBeenCalledOnce();
    expect(samples.some(sample => Math.abs(sample) > 0.1)).toBe(true);
    expect(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 0.801)).toBe(true);
    expect(volume).toHaveBeenLastCalledWith(0.3, 0);
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(speak).toHaveBeenCalledOnce();
    audio.saveAudio({ effects: false });
    expect(source.stop).toHaveBeenCalledOnce();
    audio.playAudio({ ...plan, words: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(source.start).toHaveBeenCalledOnce();
  });
  it('pairs socket domain events with their following view and silences reconnect snapshots', async () => {
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      constructor(text: string) { this.text = text; }
    });
    vi.stubGlobal('localStorage', { getItem: () => '{"voice":true}', setItem: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
    class Socket {
      static latest: Socket;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { Socket.latest = this; }
    }
    vi.stubGlobal('WebSocket', Socket);
    const audio = await import('./audio.ts');
    const { connect, mutableState } = await import('./store.ts');
    audio.unlockAudio();
    mutableState.view = null;
    connect();
    const send = (message: unknown) => Socket.latest.onmessage!({ data: JSON.stringify(message) });
    send({ type: 'view', view: view({ awaitingTakeout: true }) });
    expect(speak).not.toHaveBeenCalled();
    // Takeout has no domain events; the new view alone starts the next turn.
    send({ type: 'view', view: view() });
    await flushAudio();
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'You require 40.' }));
    speak.mock.calls[0]![0].onend();
    await flushAudio();
    speak.mockClear();
    send({ type: 'domain', events: [{ type: 'turn.completed', playerId: 'alice', total: 60, darts: 3, busted: false }] });
    expect(speak).not.toHaveBeenCalled();
    send({ type: 'view', view: view({ awaitingTakeout: true }) });
    await flushAudio();
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({ text: '60.' }));
    speak.mock.calls[0]![0].onend();
    await flushAudio();
    speak.mockClear();
    connect();
    send({ type: 'view', view: view() });
    await flushAudio();
    expect(speak).not.toHaveBeenCalled();
    // Simulator bust and immediate takeout must preserve both calls, in order.
    send({ type: 'domain', events: [
      { type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: 0 },
      { type: 'player.busted', playerId: 'alice', reason: 'below zero' },
      { type: 'turn.completed', playerId: 'alice', total: 0, darts: 1, busted: true },
    ] });
    const recent = [{ id: 'bust', playerId: 'alice', label: 'T20', value: 60 }];
    send({ type: 'view', view: view({ awaitingTakeout: true, recent }) });
    send({ type: 'view', view: view({ recent }) });
    await flushAudio();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]![0].text).toBe('Bust.');
    speak.mock.calls[0]![0].onend();
    await flushAudio();
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak.mock.calls[1]![0].text).toBe('You require 40.');
  });
});

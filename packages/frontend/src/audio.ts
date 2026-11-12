import { reactive, readonly } from 'vue';
import type { DomainEvent, MatchView } from '@darts/schema';

export interface AudioSettings { voice: boolean; effects: boolean; volume: number }
const defaults: AudioSettings = { voice: false, effects: false, volume: 0.7 };
const storageKey = 'opendarts.audio';
function load(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return { voice: saved.voice === true, effects: saved.effects === true,
      volume: typeof saved.volume === 'number' && Number.isFinite(saved.volume)
        ? Math.max(0, Math.min(1, saved.volume)) : defaults.volume };
  } catch { return { ...defaults }; }
}
const settings = reactive(load());
export const audioSettings = readonly(settings);
export const voiceSupported = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
export const effectsSupported = typeof AudioContext !== 'undefined';

type Cue = 'bust' | 'win' | 'explosion';
export interface AudioPlan { words: string[]; cue?: Cue; throwConfirmed?: boolean; explosion?: boolean }

/** Domain events precede their view. Use both to avoid guessing rules or replaying history. */
export function planAudio(old: MatchView | null, next: MatchView | null, events: readonly DomainEvent[]): AudioPlan {
  const words: string[] = [];
  let cue: Cue | undefined;
  if (!next) return { words };
  const win = events.find(e => e.type === 'match.won') ?? events.find(e => e.type === 'leg.won');
  const checkout = events.find(e => e.type === 'x01.checkout');
  const bust = events.find(e => e.type === 'player.busted');
  const gotcha = events.some(e => e.type === 'gotcha.knockback');
  const explosion = events.some(e => e.type === 'minefield.exploded');
  if (win && 'playerId' in win) {
    words.push(win.type === 'match.won' ? 'Game shot. Match won.' : 'Game shot. Leg won.');
    cue = 'win';
  } else if (checkout && 'playerId' in checkout) {
    words.push('Checkout.');
    cue = 'win';
  } else if (bust && 'playerId' in bust) {
    words.push('Bust.');
    cue = 'bust';
  } else if (gotcha) {
    words.push('Gotcha!');
  } else {
    // A zero counted value may be a failed double-in or a special game rule.
    // Only the actual segment label proves the dart missed the board.
    const missed = events.some(e => e.type === 'throw.recorded' &&
      next.recent.at(-1)?.playerId === e.playerId && next.recent.at(-1)?.label === 'MISS');
    if (missed) words.push('Miss.');
    for (const e of events) {
      if (e.type === 'turn.completed' && !e.busted && !explosion) words.push(e.total === 0 ? 'No score.' : `${e.total}.`);
    }
  }
  // Only announce a requirement on arrival at the oche, with a server-provided
  // legal route. A bogey number or an undo must never trigger a checkout call.
  const starts = events.some(e => e.type === 'match.started');
  const turnChanged = old?.matchId === next.matchId && (
    old.activePlayerId !== next.activePlayerId || old.leg !== next.leg || old.set !== next.set ||
    (old.awaitingTakeout && !next.awaitingTakeout));
  const corrected = old?.matchId === next.matchId && old.recent.some(dart =>
    !next.recent.some(d => d.id === dart.id && d.label === dart.label)) &&
    !events.some(e => e.type === 'throw.recorded');
  if (!corrected && (starts || turnChanged) && next.status === 'playing' && !next.awaitingTakeout && next.gameType === 'x01') {
    const player = next.players.find(p => p.playerId === next.activePlayerId);
    if (player?.checkout?.length) words.push(`You require ${player.score}.`);
  }
  if (!corrected && next.gameType === 'golf' && next.status === 'playing' && !next.awaitingTakeout) {
    const hole = next.players.find(p => p.playerId === next.activePlayerId)?.detail.hole;
    const previousHole = old?.players.find(p => p.playerId === old.activePlayerId)?.detail.hole;
    const completedHole = events.some(e => e.type === 'golf.hole');
    // Read the actual current target, not the projected remaining-dart hints:
    // handicaps can keep a hole open across several turns. After the last dart,
    // wait for handover and call the incoming target even if its number is unchanged.
    if ((starts || turnChanged || (completedHole && hole !== previousHole)) &&
      typeof hole === 'number' && Number.isInteger(hole) && hole > 0) {
      words.push(`Target ${hole}.`);
    }
  }
  const last = next.recent.at(-1);
  const throwConfirmed = !gotcha && !explosion && last && last.label !== 'MISS' &&
    events.some(e => e.type === 'throw.recorded' && e.playerId === last.playerId) &&
    !events.some(e => e.type === 'player.busted' || (e.type === 'turn.completed' && e.busted));
  return { words, cue, ...(throwConfirmed ? { throwConfirmed: true } : {}), ...(explosion ? { explosion: true } : {}) };
}

let context: AudioContext | undefined;
let unlocked = false;
const queue: AudioPlan[] = [];
let active = false;
let generation = 0;
let finishSpeech: (() => void) | undefined;
const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
const tones = new Set<OscillatorNode | AudioBufferSourceNode>();
let glassBuffer: AudioBuffer | undefined;
let explosionBuffer: AudioBuffer | undefined;
export function stopAudio(): void {
  generation++;
  queue.length = 0;
  active = false;
  finishSpeech?.();
  finishSpeech = undefined;
  for (const [timer, resolve] of waits) { clearTimeout(timer); resolve(); }
  waits.clear();
  if (voiceSupported) speechSynthesis.cancel();
  for (const tone of tones) { try { tone.stop(); } catch { /* Already ended. */ } }
  tones.clear();
}

/** Called inside a user gesture, so browsers can authorise sound playback. */
export function unlockAudio(): void {
  unlocked = true;
  if ((!settings.effects && !settings.voice) || !effectsSupported) return;
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
  } catch { /* Audio must never interrupt scoring. */ }
}

export function saveAudio(patch: Partial<AudioSettings>): void {
  Object.assign(settings, patch);
  settings.volume = Number.isFinite(settings.volume) ? Math.max(0, Math.min(1, settings.volume)) : defaults.volume;
  stopAudio();
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Private browsing. */ }
  unlockAudio();
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { waits.delete(timer); resolve(); }, ms);
    waits.set(timer, resolve);
  });
}

function tone(frequency: number, start: number, duration: number, volume: number, type: OscillatorType = 'sine', fallTo?: number): void {
  const oscillator = context!.createOscillator();
  const gain = context!.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  if (fallTo !== undefined) {
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(fallTo, start + duration * 0.6);
  }
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.00001, start + duration);
  oscillator.connect(gain).connect(context!.destination);
  tones.add(oscillator);
  oscillator.onended = () => { tones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(start);
  oscillator.stop(start + duration);
}

async function primeOutput(current: number): Promise<void> {
  if (!effectsSupported) return;
  try {
    unlockAudio();
    if (context?.state === 'suspended') await context.resume();
    if (current !== generation || !context || context.state !== 'running') return;
    // Open the output before speech starts, giving sleeping audio devices a
    // second to wake up without sacrificing the first spoken word.
    tone(30, context.currentTime, 1, 0.0001);
    await wait(1000);
  } catch { /* Speech can still work if Web Audio is unavailable. */ }
}

async function playCue(cue: Cue | undefined): Promise<void> {
  if (!settings.effects || !effectsSupported || !cue) return;
  try {
    if (!context || context.state !== 'running') return;
    if (cue === 'explosion') {
      playExplosion();
      await wait(1100);
      return;
    }
    if (cue === 'bust') {
      playGlassShatter();
      await wait(900);
      return;
    }
    const notes = [523, 659, 784];
    notes.forEach((frequency, i) => {
      tone(frequency, context!.currentTime + i * 0.12, 0.2, settings.volume * 0.18);
    });
    // Effects finish before speech, so the opening syllable stays clear.
    await wait((notes.length - 1) * 120 + 300);
  } catch { /* Unsupported or blocked audio is silent. */ }
}

/** A sharp crack followed by scattered, inharmonic glass fragments. Generated
 * locally once, with no downloaded sample or network dependency. */
function playGlassShatter(): void {
  if (!glassBuffer) {
    const rate = context!.sampleRate;
    glassBuffer = context!.createBuffer(1, Math.ceil(rate * 0.8), rate);
    const samples = glassBuffer.getChannelData(0);
    let seed = 73;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
    let previous = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      const noise = random() * 2 - 1;
      samples[i] = (noise - previous) * (Math.exp(-t * 85) + 0.2 * Math.exp(-t * 12));
      previous = noise;
    }
    for (let shard = 0; shard < 24; shard++) {
      const onset = shard === 0 ? 0 : random() * 0.35;
      const frequency = 1700 + random() * Math.min(6500, rate * 0.35);
      const decay = 14 + random() * 30;
      for (let i = Math.ceil(onset * rate); i < samples.length; i++) {
        const t = i / rate - onset;
        samples[i] += 0.12 * Math.exp(-t * decay) * (
          Math.sin(2 * Math.PI * frequency * t) + 0.4 * Math.sin(2 * Math.PI * frequency * 1.47 * t));
      }
    }
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    for (let i = 0; i < samples.length; i++) samples[i] *= 0.8 / peak;
  }
  playBuffer(glassBuffer);
}

/** A sharp initial blast followed by a low boom and fading noise. */
function playExplosion(): void {
  if (!explosionBuffer) {
    const rate = context!.sampleRate;
    explosionBuffer = context!.createBuffer(1, rate, rate);
    const samples = explosionBuffer.getChannelData(0);
    let seed = 91;
    let rumble = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const noise = (seed >>> 0) / 2147483648 - 1;
      rumble += 0.15 * (noise - rumble);
      const envelope = (1 - Math.exp(-t * 900)) * Math.exp(-t * 7);
      const boom = Math.sin(2 * Math.PI * (45 * t + 3 * (1 - Math.exp(-t * 18))));
      samples[i] = envelope * (0.5 * boom + 0.3 * rumble + 0.2 * noise * Math.exp(-t * 55));
    }
  }
  playBuffer(explosionBuffer);
}

function playBuffer(buffer: AudioBuffer): void {
  const source = context!.createBufferSource();
  const gain = context!.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(settings.volume * 0.6, context!.currentTime);
  source.connect(gain).connect(context!.destination);
  tones.add(source);
  source.onended = () => { tones.delete(source); source.disconnect(); gain.disconnect(); };
  source.start();
}

function speak(words: string[]): Promise<void> {
  if (!settings.voice || !voiceSupported || !words.length) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      if (finishSpeech === done) finishSpeech = undefined;
      resolve();
    };
    try {
      const utterance = new SpeechSynthesisUtterance(words.join(' '));
      utterance.lang = 'en-GB';
      utterance.volume = settings.volume;
      utterance.onend = utterance.onerror = done;
      finishSpeech = done;
      speechSynthesis.speak(utterance);
    } catch { done(); }
  });
}

async function drain(current: number): Promise<void> {
  await primeOutput(current);
  while (current === generation && queue.length) {
    const plan = queue.shift()!;
    if (plan.explosion) await playCue('explosion');
    if (current !== generation) return;
    await playCue(plan.cue);
    if (current !== generation) return;
    await speak(plan.words);
  }
  if (current === generation) active = false;
}

export function playAudio(plan: AudioPlan): void {
  if (!unlocked || (typeof document !== 'undefined' && document.hidden) || settings.volume === 0) return;
  if (plan.throwConfirmed && settings.effects && effectsSupported) void confirmThrow(generation);
  if (!(settings.voice && voiceSupported && plan.words.length) && !(settings.effects && effectsSupported && (plan.cue || plan.explosion))) return;
  queue.push({ words: [...plan.words], cue: plan.cue, explosion: plan.explosion });
  if (!active) {
    active = true;
    void drain(generation);
  }
}

/** Receipt feedback bypasses the commentary queue and its output lead-in. */
async function confirmThrow(current: number): Promise<void> {
  try {
    unlockAudio();
    if (context?.state === 'suspended') await context.resume();
    if (current !== generation || !settings.effects || !context || context.state !== 'running') return;
    // Short, low, falling resonance gives a dull board knock rather than a beep.
    tone(220, context.currentTime, 0.075, settings.volume * 0.25, 'sine', 90);
  } catch { /* Audio must never interrupt scoring. */ }
}

export function previewAudio(): void {
  unlockAudio();
  playAudio({ words: ['One hundred and eighty. You require forty.'], cue: 'win' });
}

import { BOARD_MM, segmentLabel, type BullOffResult, type BullOffView, type DartThrow, type Player } from '@darts/schema';

type State = Omit<BullOffView, 'canUndo' | 'revision'>;
const bands = { BULL: 0, OUTER_BULL: 1, SINGLE_INNER: 2, TRIPLE: 3, SINGLE_OUTER: 4, DOUBLE: 5, MISS: 6 } as const;
function distanceBand(distanceMm: number): number {
  const boundaries = [BOARD_MM.BULL_INNER, BOARD_MM.BULL_OUTER, BOARD_MM.TRIPLE_INNER,
    BOARD_MM.TRIPLE_OUTER, BOARD_MM.DOUBLE_INNER, BOARD_MM.DOUBLE_OUTER, BOARD_MM.BOARD_OUTER];
  const band = boundaries.findIndex(radius => distanceMm <= radius);
  return band < 0 ? 6 : band;
}

/** One dart each; rank all places, rethrowing only unresolved groups in reverse
 * order. Bulls in the same ring tie. Other hits compare measured radii to
 * 0.1 mm; without coordinates, hits in the same radial zone tie. A measured
 * distance can be entered instead. A miss with no board position is a retry.
 * Setup stays in memory, separate from the match log, scores and statistics. */
export class BullOff {
  private state: State;
  private history: State[] = [];
  private seen = new Set<string>();
  private revision = 0;

  constructor(id: string, players: Player[]) {
    if (players.length < 2 || new Set(players.map(p => p.id)).size !== players.length) throw new Error('Bull-off needs at least two distinct players');
    this.state = { id, players: structuredClone(players), groups: [players.map(p => p.id)], round: 1,
      queue: players.map(p => p.id), activePlayerId: players[0]!.id, awaitingTakeout: false,
      complete: false, retry: false, results: {} };
  }

  get view(): BullOffView { return { ...structuredClone(this.state), revision: this.revision, canUndo: this.history.length > 0 }; }

  record(dart: DartThrow): boolean {
    if (this.seen.has(dart.id)) return false;
    this.seen.add(dart.id);
    const radius = dart.coords ? Math.hypot(dart.coords.x, dart.coords.y) : null;
    const distanceMm = radius !== null && Number.isFinite(radius) ? Math.round(radius * 10) / 10 : null;
    const band = dart.segment.ring === 'BULL' || dart.segment.ring === 'OUTER_BULL' || radius === null || !Number.isFinite(radius)
      ? bands[dart.segment.ring] : distanceBand(radius);
    return this.recordResult({ label: segmentLabel(dart.segment), band,
      distanceMm, coords: dart.coords }, distanceMm !== null && distanceMm > BOARD_MM.BOARD_OUTER || dart.segment.ring === 'MISS' && distanceMm === null);
  }

  measure(distanceMm: number): boolean {
    if (!Number.isFinite(distanceMm) || distanceMm < 0 || distanceMm > BOARD_MM.BOARD_OUTER) throw new Error('Enter a distance from 0 to 225 mm');
    const band = distanceBand(distanceMm);
    return this.recordResult({ label: band === 0 ? 'BULL' : band === 1 ? '25' : `${distanceMm.toFixed(1)} mm`,
      band, distanceMm: Math.round(distanceMm * 10) / 10, coords: null }, false);
  }

  private recordResult(result: BullOffResult, retry: boolean): boolean {
    if (this.state.complete || this.state.awaitingTakeout || !this.state.activePlayerId) return false;
    this.history.push(structuredClone(this.state));
    this.state.results[this.state.activePlayerId] = result;
    this.state.retry = retry;
    this.state.awaitingTakeout = true;
    this.revision++;
    return true;
  }

  next(): boolean {
    if (!this.state.awaitingTakeout || this.state.complete) return false;
    this.revision++;
    this.state.awaitingTakeout = false;
    if (this.state.retry) { this.state.retry = false; return true; }
    const index = this.state.queue.indexOf(this.state.activePlayerId!);
    if (index < this.state.queue.length - 1) {
      this.state.activePlayerId = this.state.queue[index + 1]!;
      return true;
    }
    this.rankGroup();
    const tied = this.state.groups.find(group => group.length > 1);
    if (tied) {
      this.state.round++;
      // Each successive tied round reverses its preceding throwing order.
      this.state.queue = this.state.queue.filter(id => tied.includes(id)).length === tied.length
        ? this.state.queue.filter(id => tied.includes(id)).reverse() : [...tied].reverse();
      this.state.activePlayerId = this.state.queue[0]!;
    } else {
      this.state.complete = true;
      this.state.activePlayerId = null;
      this.state.queue = [];
    }
    return true;
  }

  private rankGroup(): void {
    const groupIndex = this.state.groups.findIndex(group => group.includes(this.state.activePlayerId!));
    const group = this.state.groups[groupIndex]!;
    const ranked: string[][] = [];
    for (let band = 0; band <= 6; band++) {
      const members = group.filter(id => this.state.results[id]!.band === band);
      if (!members.length) continue;
      if (band < 2 || members.some(id => this.state.results[id]!.distanceMm === null)) { ranked.push(members); continue; }
      members.sort((a, b) => this.state.results[a]!.distanceMm! - this.state.results[b]!.distanceMm!);
      for (const id of members) {
        const previous = ranked.at(-1);
        if (previous && this.state.results[previous[0]!]!.band === band &&
          this.state.results[previous[0]!]!.distanceMm === this.state.results[id]!.distanceMm) previous.push(id);
        else ranked.push([id]);
      }
    }
    this.state.groups.splice(groupIndex, 1, ...ranked);
  }

  undo(): void {
    const before = this.history.pop();
    if (before) { this.state = before; this.revision++; }
  }
}

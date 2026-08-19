import type { InOutMode } from '@darts/schema';
import { segmentLabel, segmentValue, type Segment } from '@darts/schema';

/** Every segment a dart can land on, ordered so good routes are found first. */
function candidateSegments(): Segment[] {
  const out: Segment[] = [];
  for (let n = 20; n >= 1; n--) out.push({ number: n, ring: 'TRIPLE' });
  out.push({ number: 25, ring: 'BULL' });
  for (let n = 20; n >= 1; n--) out.push({ number: n, ring: 'DOUBLE' });
  out.push({ number: 25, ring: 'OUTER_BULL' });
  for (let n = 20; n >= 1; n--) out.push({ number: n, ring: 'SINGLE_OUTER' });
  return out;
}

const CANDIDATES = candidateSegments();

/**
 * How awkward a segment is to aim at deliberately.
 *
 * Used both to order finishing darts and to keep setup advice throwable.
 */
function dartDifficulty(segment: Segment): number {
  switch (segment.ring) {
    case 'DOUBLE':
      return 15;
    case 'BULL':
      return 8;
    case 'OUTER_BULL':
      return 6;
    case 'TRIPLE':
      return 3;
    default:
      return 0;
  }
}

/**
 * Segments that are legal as the final dart under a given out-rule, easiest
 * first. The ordering matters: under straight-out, 20 should finish on S20
 * rather than D10, which scores the same but is a much smaller target.
 */
function finishers(outMode: InOutMode): Segment[] {
  const legal =
    outMode === 'straight'
      ? CANDIDATES
      : outMode === 'master'
        ? CANDIDATES.filter((s) => s.ring === 'DOUBLE' || s.ring === 'TRIPLE' || s.ring === 'BULL')
        : CANDIDATES.filter((s) => s.ring === 'DOUBLE' || s.ring === 'BULL');
  return [...legal].sort((a, b) => dartDifficulty(a) - dartDifficulty(b));
}

/**
 * Checkout routes are looked up constantly -- once per dart, for the setup
 * search, and for every rating of a candidate leave. The answer only depends on
 * (score, darts, outMode), so cache it.
 */
const checkoutCache = new Map<string, string[] | null>();

/**
 * Suggest a checkout route for `score` using at most `dartsLeft` darts.
 *
 * Returns segment labels (e.g. ["T20","T20","D25"]) or null when no route
 * exists. Preference order is inherited from the candidate ordering: triples
 * first, so the highest-percentage conventional routes surface first.
 */
export function suggestCheckout(
  score: number,
  dartsLeft: number,
  outMode: InOutMode = 'double',
): string[] | null {
  const key = `${score}:${dartsLeft}:${outMode}`;
  const cached = checkoutCache.get(key);
  if (cached !== undefined) return cached;
  const computed = computeCheckout(score, dartsLeft, outMode);
  checkoutCache.set(key, computed);
  return computed;
}

function computeCheckout(
  score: number,
  dartsLeft: number,
  outMode: InOutMode,
): string[] | null {
  if (score <= 0 || dartsLeft <= 0) return null;
  // Nothing above 170 is checkable, even with three triples plus bull.
  if (score > 170) return null;

  const finishing = finishers(outMode);

  const search = (remaining: number, darts: number): Segment[] | null => {
    if (darts <= 0) return null;

    // Try to finish with this dart.
    for (const seg of finishing) {
      if (segmentValue(seg) === remaining) return [seg];
    }
    if (darts === 1) return null;

    // Otherwise set up with a non-final dart.
    for (const seg of CANDIDATES) {
      const v = segmentValue(seg);
      if (v <= 0 || v >= remaining) continue;
      const rest = search(remaining - v, darts - 1);
      if (rest) return [seg, ...rest];
    }
    return null;
  };

  const route = search(score, Math.min(dartsLeft, 3));
  return route ? route.map(segmentLabel) : null;
}

/** True when the score cannot be finished at all with three darts. */
export function isBogeyNumber(score: number, outMode: InOutMode = 'double'): boolean {
  return suggestCheckout(score, 3, outMode) === null;
}

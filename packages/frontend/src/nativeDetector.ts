export type RenderImages = Record<'cam0' | 'cam1' | 'cam2', string>;
export interface RenderConfiguration {
  width: number; height: number;
  cameras: Record<'cam0' | 'cam1' | 'cam2', { K: number[]; R: number[]; t: number[]; reference: string }>;
}
export interface RenderFrameBatch {
  session: string; sequence: number; timestampMs: number; images: RenderImages;
}

export interface NativeState {
  session: string;
  source: 'synthetic' | 'replay' | 'rendered';
  renderSession?: string | null;
  diagnostics?: Record<string, unknown>;
  running: boolean;
  status: string;
  cameras: { id: string; calibrated: boolean; available: boolean }[];
  occupancy: number;
  pending: { stableFrames: number; requiredFrames: number; adoptingBaseline: boolean };
  faults: string[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed detector state');
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Fail closed: stale or malformed diagnostics must never enable synthetic controls. */
export function parseNativeState(value: unknown): NativeState {
  const s = record(value);
  const p = record(s.pending);
  if (typeof s.session !== 'string' || !s.session || (s.source !== 'synthetic' && s.source !== 'replay' && s.source !== 'rendered') ||
      (s.renderSession !== undefined && s.renderSession !== null && (typeof s.renderSession !== 'string' || !s.renderSession)) ||
      (s.diagnostics !== undefined && (!s.diagnostics || typeof s.diagnostics !== 'object' || Array.isArray(s.diagnostics))) ||
      typeof s.running !== 'boolean' || typeof s.status !== 'string' || !integer(s.occupancy) ||
      !integer(p.stableFrames) || !integer(p.requiredFrames) || p.requiredFrames === 0 ||
      typeof p.adoptingBaseline !== 'boolean' || !Array.isArray(s.faults) ||
      !s.faults.every(f => typeof f === 'string') || !Array.isArray(s.cameras) ||
      s.cameras.length < 2 || s.cameras.length > 3) throw new Error('Malformed detector state');
  const cameras = s.cameras.map(value => {
    const c = record(value);
    if (typeof c.id !== 'string' || !/^cam[0-2]$/.test(c.id) ||
        typeof c.calibrated !== 'boolean' || typeof c.available !== 'boolean') {
      throw new Error('Malformed detector camera');
    }
    return { id: c.id, calibrated: c.calibrated, available: c.available };
  });
  if (new Set(cameras.map(c => c.id)).size !== cameras.length) throw new Error('Duplicate detector camera');
  return {
    session: s.session, source: s.source as NativeState['source'], running: s.running, status: s.status,
    occupancy: s.occupancy, cameras, faults: s.faults as string[],
    ...(s.renderSession !== undefined ? { renderSession: s.renderSession as string | null } : {}),
    ...(s.diagnostics !== undefined ? { diagnostics: s.diagnostics as Record<string, unknown> } : {}),
    pending: { stableFrames: p.stableFrames, requiredFrames: p.requiredFrames, adoptingBaseline: p.adoptingBaseline },
  };
}

export interface ReconstructionResult {
  x: number; y: number; uncertaintyMm: number; reprojectionPx: number;
}

/** The rendered service repeats the same reconstruction in each camera; read cam0 once.
 * Hypotheses are intentionally excluded: they are alternatives, not detector results.
 */
export function renderedResults(state: NativeState | null): ReconstructionResult[] {
  const camera = state?.diagnostics?.cam0;
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) return [];
  const rows = (camera as Record<string, unknown>).reconstructed;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const r = value as Record<string, unknown>;
    const p = r.impactMm;
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v)) ||
        typeof r.uncertaintyMm !== 'number' || !Number.isFinite(r.uncertaintyMm) || r.uncertaintyMm < 0 ||
        typeof r.reprojectionPx !== 'number' || !Number.isFinite(r.reprojectionPx) || r.reprojectionPx < 0) return [];
    return [{ x: p[0] as number, y: p[1] as number, uncertaintyMm: r.uncertaintyMm, reprojectionPx: r.reprojectionPx }];
  });
}

export function placementClick(start: { x: number; y: number }, end: { x: number; y: number }, maxMovement: number): boolean {
  return Number.isFinite(maxMovement) && maxMovement <= 5 && Math.hypot(end.x - start.x, end.y - start.y) <= 5;
}

export interface RenderSnapshotContext {
  detectorSession: string | undefined;
  renderSession: string | null;
  configuring: boolean;
  confirmed: boolean;
  previousSnapshot: NativeState | null;
}

/** Old baseline faults may survive polling across configure. Only empty frames are allowed while waiting. */
export function renderedSnapshotGate(state: NativeState | null, context: RenderSnapshotContext): 'waiting' | 'current' | 'invalid' | 'stale' {
  if (!state || state.source !== 'rendered' || !state.running || state.session !== context.detectorSession) return 'invalid';
  if (context.configuring || state === context.previousSnapshot) return 'waiting';
  if (state.renderSession !== undefined && state.renderSession !== context.renderSession) {
    return context.confirmed ? 'stale' : 'waiting';
  }
  return state.faults.length ? 'invalid' : 'current';
}

export function renderedBaselineReady(state: NativeState | null, confirmed: boolean): boolean {
  return confirmed && !!state && state.source === 'rendered' && state.running && !state.pending.adoptingBaseline &&
    state.pending.stableFrames >= state.pending.requiredFrames && !state.faults.length &&
    state.cameras.length === 3 && state.cameras.every(camera => camera.available && camera.calibrated);
}

/** Never use a detector-supplied frameUrl: it could contact another host. */
export function nativeFrameUrl(id: string, revision: number): string {
  if (!/^cam[0-2]$/.test(id)) throw new Error('Invalid camera ID');
  return `/api/native/cameras/${id}/frame?t=${revision}`;
}

export function validImpact(x: unknown, y: unknown): boolean {
  return [x, y].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 200);
}

export function validRemoveCount(count: unknown): count is number {
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
}

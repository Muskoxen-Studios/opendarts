import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_CAPTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/board-captures');
const ID_PATTERN = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMERA_FILES = new Set(['camera-0.jpg', 'camera-0.png', 'camera-0.webp', 'camera-1.jpg', 'camera-1.png', 'camera-1.webp', 'camera-2.jpg', 'camera-2.png', 'camera-2.webp']);
const MIME_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export type CaptureReviewStatus = 'confirmed' | 'incorrect' | 'uncertain' | 'unreviewed';
export interface CaptureReview {
  status: CaptureReviewStatus;
  reason?: string;
  correctedCoords?: { x: number; y: number } | null;
  notes?: string;
  updatedAt: string;
}

let configuredDirectory: string | null = null;
function rootDir(): string { return resolve(configuredDirectory ?? process.env.BOARD_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR); }
function validId(id: string): boolean { return ID_PATTERN.test(id); }

async function captureDir(id: string): Promise<string | null> {
  if (!validId(id)) return null;
  const root = rootDir();
  const base = join(root, id);
  try {
    const [rootReal, info] = await Promise.all([realpath(root), lstat(base)]);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const actual = await realpath(base);
    if (dirname(actual) !== rootReal) return null;
    return actual;
  } catch { return null; }
}

async function readCapture(id: string): Promise<{ dir: string; manifest: Record<string, any>; review: CaptureReview } | null> {
  const dir = await captureDir(id);
  if (!dir) return null;
  try {
    const manifestPath = join(dir, 'manifest.json');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return null;
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
    if (!raw || raw.captureId !== id || raw.format !== 'darts-board-capture-v1' || !Array.isArray(raw.cameras)) return null;
    const review = await readReview(dir, id);
    return { dir, manifest: raw, review };
  } catch { return null; }
}

async function readReview(dir: string, id: string): Promise<CaptureReview> {
  try {
    const reviewDir = join(dir, '_reviews');
    const reviewDirInfo = await lstat(reviewDir);
    if (!reviewDirInfo.isDirectory() || reviewDirInfo.isSymbolicLink() || dirname(await realpath(reviewDir)) !== dir) {
      return { status: 'unreviewed', updatedAt: '' };
    }
    const reviewPath = join(reviewDir, `${id}.json`);
    const reviewInfo = await lstat(reviewPath);
    if (!reviewInfo.isFile() || reviewInfo.isSymbolicLink() || dirname(await realpath(reviewPath)) !== await realpath(reviewDir)) {
      return { status: 'unreviewed', updatedAt: '' };
    }
    const value = JSON.parse(await readFile(reviewPath, 'utf8')) as CaptureReview;
    if (['confirmed', 'incorrect', 'uncertain', 'unreviewed'].includes(value.status)) return value;
  } catch { /* A missing sidecar means not reviewed. */ }
  return { status: 'unreviewed', updatedAt: '' };
}

function publicManifest(id: string, manifest: Record<string, any>, review: CaptureReview): Record<string, unknown> {
  return {
    ...manifest,
    cameras: manifest.cameras.map((camera: Record<string, unknown>) => ({
      ...camera,
      file: null,
      url: typeof camera.file === 'string' && CAMERA_FILES.has(camera.file)
        ? `/api/captures/${encodeURIComponent(id)}/cameras/${String(camera.camera)}` : null,
    })),
    review,
  };
}

export async function listCaptures(): Promise<Record<string, unknown>[]> {
  let entries;
  try { entries = await (await import('node:fs/promises')).readdir(rootDir(), { withFileTypes: true }); }
  catch { return []; }
  const records = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && validId(entry.name))
    .map(async (entry) => {
      const capture = await readCapture(entry.name);
      return capture ? publicManifest(entry.name, capture.manifest, capture.review) : null;
    }));
  return records.filter((record): record is Record<string, unknown> => record !== null)
    .sort((a, b) => String(a.captureStartedAt).localeCompare(String(b.captureStartedAt)));
}

export async function getCapture(id: string): Promise<Record<string, unknown> | null> {
  const capture = await readCapture(id);
  return capture ? publicManifest(id, capture.manifest, capture.review) : null;
}

export async function getCaptureCamera(id: string, camera: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!/^[0-2]$/.test(camera)) return null;
  const capture = await readCapture(id);
  if (!capture) return null;
  const record = capture.manifest.cameras.find((item: Record<string, unknown>) => item.camera === Number(camera));
  const file = record?.file;
  if (typeof file !== 'string' || !CAMERA_FILES.has(file) || !file.startsWith(`camera-${camera}.`)) return null;
  try {
    const path = join(capture.dir, file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return { bytes: await readFile(path), contentType: MIME_TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' };
  } catch { return null; }
}

export async function saveCaptureReview(id: string, body: unknown): Promise<CaptureReview | null> {
  const capture = await readCapture(id);
  if (!capture) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('review must be an object');
  const value = body as Record<string, unknown>;
  if (!['confirmed', 'incorrect', 'uncertain', 'unreviewed'].includes(String(value.status))) throw new Error('invalid review status');
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 500)) throw new Error('reason must be a string of at most 500 characters');
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000)) throw new Error('notes must be a string of at most 4000 characters');
  let correctedCoords: { x: number; y: number } | null | undefined;
  if (value.correctedCoords !== undefined) {
    if (value.correctedCoords === null) correctedCoords = null;
    else if (value.correctedCoords && typeof value.correctedCoords === 'object' && !Array.isArray(value.correctedCoords)) {
      const coords = value.correctedCoords as Record<string, unknown>;
      if (typeof coords.x !== 'number' || !Number.isFinite(coords.x) || Math.abs(coords.x) > 300 || typeof coords.y !== 'number' || !Number.isFinite(coords.y) || Math.abs(coords.y) > 300) throw new Error('correctedCoords must contain finite x and y values within ±300 mm');
      correctedCoords = { x: coords.x, y: coords.y };
    } else throw new Error('correctedCoords must be an x/y object or null');
  }
  const review: CaptureReview = {
    status: value.status as CaptureReviewStatus,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(correctedCoords !== undefined ? { correctedCoords } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    updatedAt: new Date().toISOString(),
  };
  const directory = join(capture.dir, '_reviews');
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || dirname(await realpath(directory)) !== capture.dir) {
    throw new Error('review directory is not contained by the capture');
  }
  const destination = join(directory, `${id}.json`);
  try {
    const previous = await lstat(destination);
    if (!previous.isFile() || previous.isSymbolicLink() || dirname(await realpath(destination)) !== await realpath(directory)) {
      throw new Error('review file is not contained by the capture');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.review-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return review;
}

/** Mountable read/review-only API for the standalone capture review page. */
export async function createCaptureReviewHandler(options: { directory?: string } = {}) {
  configuredDirectory = options.directory ? resolve(options.directory) : null;
  return async (req: IncomingMessage, res: ServerResponse, url = new URL(req.url ?? '/', 'http://localhost')): Promise<boolean> => {
    const pathname = url.pathname;
    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && pathname === '/api/captures') {
      sendJson(200, { captures: await listCaptures() });
      return true;
    }
    const cameraMatch = /^\/api\/captures\/([^/]+)\/cameras\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && cameraMatch) {
      const image = await getCaptureCamera(decodeURIComponent(cameraMatch[1]!), cameraMatch[2]!);
      if (!image) sendJson(404, { error: 'no such capture camera' });
      else {
        res.writeHead(200, { 'content-type': image.contentType, 'content-length': image.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(image.bytes);
      }
      return true;
    }
    const detailMatch = /^\/api\/captures\/([^/]+)(?:\/review)?$/.exec(pathname);
    if (detailMatch && req.method === 'GET') {
      const capture = await getCapture(decodeURIComponent(detailMatch[1]!));
      sendJson(capture ? 200 : 404, capture ? { capture } : { error: 'no such capture' });
      return true;
    }
    if (detailMatch && req.method === 'PUT') {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 8192) tooLarge = true;
        else if (!tooLarge) chunks.push(chunk as Buffer);
      }
      if (tooLarge) { sendJson(413, { error: 'review body too large' }); return true; }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { sendJson(400, { error: 'invalid JSON body' }); return true; }
      try {
        const review = await saveCaptureReview(decodeURIComponent(detailMatch[1]!), body);
        sendJson(review ? 200 : 404, review ? { review } : { error: 'no such capture' });
      } catch (error) { sendJson(400, { error: (error as Error).message }); }
      return true;
    }
    return false;
  };
}

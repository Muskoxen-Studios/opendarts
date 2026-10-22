import { z } from 'zod';

// Three 720p grayscale base64 images plus bounded calibration/JSON overhead.
export const MAX_RENDER_BODY = 6 * 1024 * 1024;
const finite = z.number().finite();
const gray = z.string().min(4).max(1_228_800).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const camera = z.object({
  K: z.array(finite).length(9), R: z.array(finite).length(9), t: z.array(finite).length(3), reference: gray,
}).strict();
const session = z.string().min(1).max(128);

/** Calibration and pixels only. Dart placements, object masks and scores cannot cross this boundary. */
export const RenderConfigureSchema = z.object({
  width: z.number().int().min(64).max(1280), height: z.number().int().min(64).max(720),
  cameras: z.object({ cam0: camera, cam1: camera, cam2: camera }).strict(),
}).strict().superRefine((value, context) => {
  for (const id of ['cam0', 'cam1', 'cam2'] as const) {
    const reference = value.cameras[id].reference;
    if (Buffer.from(reference, 'base64').length !== value.width * value.height) {
      context.addIssue({ code: 'custom', path: ['cameras', id, 'reference'], message: 'reference dimensions do not match' });
    }
  }
});
export const RenderFramesSchema = z.object({
  session, sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), timestampMs: finite.nonnegative(),
  images: z.object({ cam0: gray, cam1: gray, cam2: gray }).strict(),
}).strict();
export const RenderResetSchema = z.object({ session }).strict();

export function renderBody(path: string, body: unknown): { success: true; data: unknown } | { success: false } {
  const schema = path.endsWith('/configure') ? RenderConfigureSchema : path.endsWith('/frames') ? RenderFramesSchema : RenderResetSchema;
  const parsed = schema.safeParse(body);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

import { createHash } from 'node:crypto';

/** Gravatar expects a SHA-256 hash of the trimmed, lowercase email. */
export function gravatarUrl(email: string | null): string | null {
  if (!email?.trim()) return null;
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `https://gravatar.com/avatar/${hash}?s=96&d=404&r=g`;
}

interface AvatarImage { data: Buffer; contentType: string }

// Share in-flight requests and briefly cache misses; bound memory across email changes.
const cache = new Map<string, { expires: number; image: Promise<AvatarImage | null> }>();
export function gravatarImage(url: string): Promise<AvatarImage | null> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.image;
  const image = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (!response.ok || !contentType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(contentType)) return null;
      return { data: Buffer.from(await response.arrayBuffer()), contentType };
    } catch {
      return null;
    }
  })();
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(url, { expires: Date.now() + 60_000, image });
  return image;
}

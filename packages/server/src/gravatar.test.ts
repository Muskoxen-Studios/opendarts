import { afterEach, describe, expect, it, vi } from 'vitest';
import { gravatarUrl, gravatarImage } from './gravatar.ts';
import { openDatabase } from './db.ts';
import { Store } from './store.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Gravatar', () => {
  it('hashes the normalized email and requests no default image', () => {
    expect(gravatarUrl(' MyEmailAddress@example.com ')).toBe('https://gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?s=96&d=404&r=g');
    expect(gravatarUrl(null)).toBeNull();
    expect(gravatarUrl('  ')).toBeNull();
  });

  it('updates the profile avatar when email changes or is cleared', () => {
    const db = openDatabase(':memory:');
    try {
      const store = new Store(db);
      const p = store.createProfile('Alice');
      store.updateProfile(p.id, { email: 'alice@example.com' });
      expect(store.listProfiles()[0]?.avatar).toBe(gravatarUrl('alice@example.com'));
      store.updateProfile(p.id, { email: 'other@example.com' });
      expect(store.getProfile(p.id)?.avatar).toBe(gravatarUrl('other@example.com'));
      store.updateProfile(p.id, { email: null });
      expect(store.getProfile(p.id)?.avatar).toBeNull();
    } finally { db.close(); }
  });

  it('shares concurrent image requests and preserves the image content type', async () => {
    const fetchImage = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchImage);
    const url = gravatarUrl('found@example.com')!;
    const [a, b] = await Promise.all([gravatarImage(url), gravatarImage(url)]);
    expect(a).toEqual({ data: Buffer.from([1, 2, 3]), contentType: 'image/png' });
    expect(b).toBe(a);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('caches missing avatars briefly and retries after expiry', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchImage = vi.fn().mockImplementation(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchImage);
    const url = gravatarUrl('missing@example.com')!;
    expect(await gravatarImage(url)).toBeNull();
    expect(await gravatarImage(url)).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    expect(await gravatarImage(url)).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('degrades to no avatar on network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await gravatarImage(gravatarUrl('offline@example.com')!)).toBeNull();
  });

  it('rejects non-image responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } })));
    expect(await gravatarImage(gravatarUrl('invalid@example.com')!)).toBeNull();
  });
});

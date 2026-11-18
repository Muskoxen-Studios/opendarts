/** Only desktop-owned local native endpoints migrate to the current launch. */
export function managedSourceConfig(config: unknown, managedUrl: string | undefined): unknown {
  if (!managedUrl || !config || typeof config !== 'object') return config;
  const source = config as Record<string, unknown>;
  if (source.kind !== 'native' || typeof source.url !== 'string') return config;
  try {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) return config;
    return { ...source, url: managedUrl };
  } catch { return config; }
}

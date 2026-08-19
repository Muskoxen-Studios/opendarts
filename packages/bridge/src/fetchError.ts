/**
 * Turn a fetch failure into something a person can act on.
 *
 * Node's fetch reports every transport failure as the same bare "fetch failed",
 * with the real reason buried in `cause`. On the settings screen that is the
 * difference between "the board is off" and "you typed the wrong address", so
 * it is worth unwrapping.
 */
export function describeFetchError(err: unknown, target: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `no response from ${target} within 4s — wrong address, or blocked by a firewall`;
  }
  switch (e?.cause?.code) {
    case 'ECONNREFUSED':
      return `${target} refused the connection — something is at that address, but the Board Manager is not listening on that port`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${target} is unreachable — check the board is powered on and on this network`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `could not resolve the hostname in ${target}`;
    case 'ECONNRESET':
      return `${target} closed the connection unexpectedly`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `${target} presented a certificate that could not be verified — try http instead of https`;
  }
  return e?.cause?.message ?? e?.message ?? String(err);
}

import { describe, expect, it } from 'vitest';
import { describeFetchError } from './fetchError.ts';

/** Node reports every transport failure as a bare "fetch failed". */
function fetchFailure(code: string): Error {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

const URL = 'http://192.168.120.40:3180';

describe('explaining why a board could not be reached', () => {
  it('never leaks the useless bare "fetch failed"', () => {
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']) {
      expect(describeFetchError(fetchFailure(code), URL)).not.toContain('fetch failed');
    }
  });

  it('distinguishes a powered-off board from a wrong port', () => {
    const off = describeFetchError(fetchFailure('EHOSTUNREACH'), URL);
    const wrongPort = describeFetchError(fetchFailure('ECONNREFUSED'), URL);
    expect(off).toMatch(/unreachable/);
    expect(off).toMatch(/powered on/);
    expect(wrongPort).toMatch(/refused/);
    expect(wrongPort).toMatch(/not listening on that port/);
    expect(off).not.toEqual(wrongPort);
  });

  it('names a timeout as such rather than as a failure', () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    expect(describeFetchError(timeout, URL)).toMatch(/no response from/);
  });

  it('points an https typo back at http', () => {
    const msg = describeFetchError(fetchFailure('DEPTH_ZERO_SELF_SIGNED_CERT'), 'https://board:3180');
    expect(msg).toMatch(/try http instead/);
  });

  it('mentions the address that was tried, so the user can spot a typo', () => {
    expect(describeFetchError(fetchFailure('ENOTFOUND'), 'http://borad.local:3180')).toContain('borad.local');
  });

  it('falls back to the underlying message for causes it does not know', () => {
    expect(describeFetchError(fetchFailure('ESOMETHINGNEW'), URL)).toBe('ESOMETHINGNEW');
  });

  it('survives a non-Error being thrown', () => {
    expect(describeFetchError('kaboom', URL)).toBe('kaboom');
  });
});

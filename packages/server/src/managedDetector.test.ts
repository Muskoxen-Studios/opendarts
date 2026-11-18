import { describe, expect, it } from 'vitest';
import { managedSourceConfig } from './managedDetector.ts';

describe('desktop managed detector configuration', () => {
  const current = 'http://127.0.0.1:42467';
  it.each(['http://127.0.0.1:8091', 'http://localhost:12345', 'http://[::1]:9000'])('migrates stale local native endpoint %s', url => {
    expect(managedSourceConfig({ kind: 'native', url }, current)).toEqual({ kind: 'native', url: current });
  });
  it('preserves remote, non-native, external and disabled configurations', () => {
    for (const config of [{ kind: 'native', url: 'http://board.local:8091' },
      { kind: 'autodarts', url: 'http://localhost:3180' }, { kind: 'simulator' },
      { kind: 'native', url: 'http://localhost:8091/custom' }, null]) {
      expect(managedSourceConfig(config, current)).toBe(config);
    }
    const config = { kind: 'native', url: 'http://localhost:8091' };
    expect(managedSourceConfig(config, undefined)).toBe(config);
    expect(managedSourceConfig(config, '')).toBe(config);
  });
});

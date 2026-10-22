import { describe, expect, it, vi } from 'vitest';
import { createScreenAwake } from './screenAwake.ts';

function sentinel() {
  let onRelease: (() => void) | undefined;
  const lock = {
    released: false,
    release: vi.fn(async () => { lock.released = true; onRelease?.(); }),
    addEventListener: (_type: 'release', listener: () => void) => { onRelease = listener; },
    systemRelease: () => { lock.released = true; onRelease?.(); },
  };
  return lock;
}

describe('screen wake lock', () => {
  it('holds only one lock and releases it when play ends', async () => {
    const lock = sentinel();
    const request = vi.fn(async () => lock);
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    expect(request).not.toHaveBeenCalled();
    awake.setEnabled(true);
    awake.retry();
    await Promise.resolve();
    awake.retry();
    expect(request).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith('active');
    awake.setEnabled(false);
    expect(lock.release).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith('inactive');
  });

  it('reacquires on returning to the visible match', async () => {
    const first = sentinel();
    const second = sentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    awake.setEnabled(true);
    await Promise.resolve();
    awake.setVisible(false);
    expect(first.release).toHaveBeenCalledOnce();
    awake.retry();
    expect(request).toHaveBeenCalledOnce();
    awake.setVisible(true);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith('active');
    awake.dispose();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it('reports system release without immediately retrying a power-saving decision', async () => {
    const lock = sentinel();
    const request = vi.fn(async () => lock);
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    awake.setEnabled(true);
    await Promise.resolve();
    lock.systemRelease();
    expect(changed).toHaveBeenLastCalledWith('released');
    expect(request).toHaveBeenCalledOnce();
    awake.dispose();
  });

  it('handles denial and allows an explicit or interaction-based retry', async () => {
    const lock = sentinel();
    const request = vi.fn().mockRejectedValueOnce(new Error('NotAllowedError')).mockResolvedValueOnce(lock);
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    awake.setEnabled(true);
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith('blocked');
    awake.retry();
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith('active');
    awake.dispose();
  });

  it.each(['end', 'dispose', 'hide'] as const)('releases a late request after %s', async (action) => {
    const lock = sentinel();
    let resolve!: (value: typeof lock) => void;
    const request = vi.fn(() => new Promise<typeof lock>((done) => { resolve = done; }));
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    awake.setEnabled(true);
    if (action === 'end') awake.setEnabled(false);
    else if (action === 'hide') awake.setVisible(false);
    else awake.dispose();
    resolve(lock);
    await Promise.resolve();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith('inactive');
  });

  it('discards an old request and acquires afresh when a new match starts', async () => {
    const old = sentinel();
    const current = sentinel();
    let resolve!: (value: typeof old) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise<typeof old>((done) => { resolve = done; })).mockResolvedValueOnce(current);
    const changed = vi.fn();
    const awake = createScreenAwake(request, changed);
    awake.setEnabled(true);
    awake.setEnabled(false);
    awake.setEnabled(true);
    resolve(old);
    await Promise.resolve();
    await Promise.resolve();
    expect(old.release).toHaveBeenCalledOnce();
    expect(current.release).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith('active');
    awake.dispose();
  });

  it('remains usable without the wake-lock API', () => {
    const changed = vi.fn();
    const awake = createScreenAwake(undefined, changed);
    awake.setEnabled(true);
    awake.retry();
    awake.dispose();
    expect(changed).toHaveBeenLastCalledWith('unsupported');
  });
});

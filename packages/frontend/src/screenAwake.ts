import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

export type ScreenAwakeState = 'inactive' | 'requesting' | 'active' | 'released' | 'blocked' | 'unsupported';
interface ScreenLock {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void, options?: { once: boolean }): void;
}

/** Owns one wake lock, including requests that finish after a match ends. */
export function createScreenAwake(
  request: (() => Promise<ScreenLock>) | undefined,
  changed: (state: ScreenAwakeState) => void,
) {
  let enabled = false;
  let visible = true;
  let disposed = false;
  let pending = false;
  let generation = 0;
  let lock: ScreenLock | null = null;

  const wanted = () => enabled && visible && !disposed;
  const release = (value: ScreenLock) => { void value.release().catch(() => {}); };
  const update = (state: ScreenAwakeState) => changed(request ? state : 'unsupported');

  async function acquire(): Promise<void> {
    if (!wanted() || !request || pending || lock) return;
    pending = true;
    const started = generation;
    update('requesting');
    try {
      const acquired = await request();
      if (!wanted() || started !== generation) {
        release(acquired);
        return;
      }
      if (acquired.released) {
        update('released');
        return;
      }
      lock = acquired;
      acquired.addEventListener('release', () => {
        if (lock !== acquired) return;
        lock = null;
        update(wanted() ? 'released' : 'inactive');
      }, { once: true });
      update('active');
    } catch {
      if (wanted() && started === generation) update('blocked');
    } finally {
      pending = false;
      // A new match or visibility cycle may have started during the request.
      if (wanted() && started !== generation) void acquire();
    }
  }

  function reconcile(): void {
    if (wanted()) void acquire();
    else {
      generation++;
      const previous = lock;
      lock = null;
      if (previous) release(previous);
      update('inactive');
    }
  }

  update('inactive');
  return {
    setEnabled(value: boolean) { enabled = value; reconcile(); },
    setVisible(value: boolean) { visible = value; reconcile(); },
    retry() { void acquire(); },
    dispose() { disposed = true; reconcile(); },
  };
}

export function useScreenAwake(enabled: Ref<boolean>) {
  const state = ref<ScreenAwakeState>('inactive');
  let controller: ReturnType<typeof createScreenAwake> | undefined;
  const visibility = () => controller?.setVisible(document.visibilityState === 'visible');
  const retry = () => controller?.retry();

  onMounted(() => {
    const request = window.isSecureContext && 'wakeLock' in navigator
      ? () => navigator.wakeLock.request('screen') : undefined;
    controller = createScreenAwake(request, (value) => { state.value = value; });
    visibility();
    controller.setEnabled(enabled.value);
    document.addEventListener('visibilitychange', visibility);
    // Some browsers require interaction, and low-power mode can release a
    // lock. Retry on the next interaction instead of repeatedly requesting it.
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
  });
  watch(enabled, (value) => controller?.setEnabled(value));
  onBeforeUnmount(() => {
    controller?.dispose();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('pointerdown', retry);
    document.removeEventListener('keydown', retry);
  });
  return { state, retry };
}

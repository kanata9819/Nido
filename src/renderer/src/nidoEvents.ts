import type { NidoEvent } from '../../shared/types';

const listeners = new Set<(event: NidoEvent) => void>();
let unsubscribe: (() => void) | undefined;

/** Cross the isolated-world bridge once; copying redraws for every subscriber stalls input. */
export function onNidoEvent(listener: (event: NidoEvent) => void): () => void {
  const notify = (event: NidoEvent): void => listener(event);
  listeners.add(notify);
  unsubscribe ??= window.nido.onEvent((event) => {
    for (const callback of [...listeners]) {
      if (!listeners.has(callback)) {
        continue;
      }
      try {
        callback(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}

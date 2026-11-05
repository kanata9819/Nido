import type { NidoEvent } from '../../shared/types';

// メインプロセスからのイベントを、画面の部品に配るしくみ。
// window.nido.onEvent（preload）での受け取りは1回だけにして、ここから登録された部品すべてに配る。
// 使う側は onNidoEvent(関数) で登録し、戻り値の関数を呼ぶと登録をやめる。
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

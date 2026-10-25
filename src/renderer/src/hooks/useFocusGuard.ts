import { useCallback, useLayoutEffect, useRef } from 'react';

/** Async actions may return focus only while their original interaction is still current. */
export function useFocusGuard(workspaceId: string): () => () => boolean {
  const revision = useRef(0);
  useLayoutEffect(() => {
    const invalidate = (): void => {
      revision.current++;
    };
    invalidate();
    document.addEventListener('focusin', invalidate);
    return () => {
      invalidate();
      document.removeEventListener('focusin', invalidate);
    };
  }, [workspaceId]);
  return useCallback(() => {
    const expected = ++revision.current;
    const focused = document.activeElement;
    return () => revision.current === expected && document.activeElement === focused;
  }, []);
}

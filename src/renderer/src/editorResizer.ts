import type { RefObject } from 'react';

/** Coalesce editor size changes while an asynchronous Neovim resize is pending. */
export function createEditorResizer(
  id: string,
  attached: RefObject<boolean>,
  onError: RefObject<(message: string) => void>,
  disposed: () => boolean
): { update: (columns: number, rows: number) => void } {
  let lastColumns = 0;
  let lastRows = 0;
  let resizePending = false;
  const resize = (columns: number, rows: number): void => {
    resizePending = true;
    void window.nido
      .resize(id, columns, rows)
      .catch((error) => {
        if (!disposed()) {
          onError.current(String(error));
        }
      })
      .finally(() => {
        resizePending = false;
        // Intermediate window sizes need no IPC while Neovim is still resizing.
        if (!disposed() && (columns !== lastColumns || rows !== lastRows)) {
          resize(lastColumns, lastRows);
        }
      });
  };
  return {
    update(columns, rows): void {
      if (!attached.current) {
        attached.current = true;
        lastColumns = columns;
        lastRows = rows;
        void window.nido.attach(id, columns, rows).catch((error) => {
          if (!disposed()) {
            onError.current(String(error));
          }
        });
      } else if (columns !== lastColumns || rows !== lastRows) {
        lastColumns = columns;
        lastRows = rows;
        if (!resizePending) {
          resize(columns, rows);
        }
      }
    }
  };
}

import { parseWslPath } from '../../shared/wsl';

export interface SavedExplorerState {
  expanded: string[];
  selected: string;
  scrollTop: number;
}

function storageKey(root: string): string {
  const remote = parseWslPath(root);
  const path = remote
    ? `//wsl.localhost/${remote.distribution.toLowerCase()}${remote.path}`
    : /^[a-z]:|^[\\/]{2}/i.test(root)
      ? root.replaceAll('\\', '/').toLowerCase()
      : root;
  return `nido.explorer.${path.replace(/\/+$/, '')}`;
}

function relativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4000 &&
    !/^[\\/]|^[a-z]:|\0/i.test(value) &&
    value.split(/[\\/]/).every((part) => !!part && part !== '.' && part !== '..')
  );
}

export function readExplorerState(root: string): SavedExplorerState {
  const empty = { expanded: [], selected: '', scrollTop: 0 };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(root)) || 'null');
    if (!value || value.version !== 1) {
      return empty;
    }
    return {
      expanded: Array.isArray(value.expanded)
        ? [...new Set<string>(value.expanded.filter(relativePath))]
        : [],
      selected: relativePath(value.selected) ? value.selected : '',
      scrollTop:
        typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop)
          ? Math.max(0, value.scrollTop)
          : 0
    };
  } catch {
    return empty;
  }
}

export function writeExplorerState(root: string, state: SavedExplorerState): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify({ version: 1, ...state }));
  } catch {
    // An unavailable or full preference store must not interrupt file navigation.
  }
}

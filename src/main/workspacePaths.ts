import { posix, relative, sep } from 'node:path';
import { parseWslPath } from '../shared/wsl';

// Linux files remain case sensitive even when Windows accesses them over WSL's share.
export function workspaceRelative(from: string, to: string): string {
  const source = parseWslPath(from);
  const target = parseWslPath(to);
  if (source && target && source.distribution.toLowerCase() === target.distribution.toLowerCase()) {
    return posix.relative(source.path, target.path).replaceAll('/', sep);
  }
  return relative(from, to);
}

export function sameWorkspacePath(from: string, to: string): boolean {
  return workspaceRelative(from, to) === '';
}

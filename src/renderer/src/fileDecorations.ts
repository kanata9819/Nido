export interface Decoration {
  code: string;
  title: string;
  diagnostic?: 'error' | 'warning';
}

export function gitFileKey(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

export function fileDecorations(
  root: string,
  git: Record<string, Decoration>,
  diagnostics: Record<string, number> = {}
): Record<string, Decoration> {
  const result: Record<string, Decoration> = {};
  for (const [path, decoration] of Object.entries(git)) {
    result[path] = { ...decoration };
  }
  for (const [path, severity] of Object.entries(diagnostics)) {
    if (severity !== 1 && severity !== 2) {
      continue;
    }
    const key = gitFileKey(path);
    const decoration = (result[key] ||= { code: '', title: '' });
    if (decoration.diagnostic !== 'error') {
      decoration.diagnostic = severity === 1 ? 'error' : 'warning';
    }
  }
  const boundary = gitFileKey(root).replace(/\/$/, '');
  // Aggregate by path segments, so similarly named siblings never inherit each other's state.
  for (const [path, decoration] of Object.entries(result)) {
    if (!boundary || !path.startsWith(`${boundary}/`)) {
      continue;
    }
    let parent = path.slice(0, path.lastIndexOf('/'));
    while (parent.length >= boundary.length) {
      const folder = (result[parent] ||= { code: '', title: '' });
      if (decoration.code && (!folder.code || decoration.code === 'M')) {
        folder.code = decoration.code;
        folder.title = 'Git: Contains changed files';
      }
      if (decoration.diagnostic && folder.diagnostic !== 'error') {
        folder.diagnostic = decoration.diagnostic;
      }
      if (parent === boundary) {
        break;
      }
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }
  return result;
}

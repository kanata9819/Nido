export interface WslPath {
  distribution: string;
  path: string;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

export function validWslDistribution(value: string): boolean {
  return (
    !!value &&
    !/[\\/]/.test(value) &&
    !hasControlCharacters(value) &&
    !value.startsWith('-') &&
    value !== '.' &&
    value !== '..'
  );
}

export function parseWslPath(value: string): WslPath | undefined {
  const match = /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i.exec(value);
  if (!match) {
    return undefined;
  }
  return { distribution: match[1], path: (match[2] || '/').replaceAll('\\', '/') };
}

export function wslHostPath(distribution: string, path: string): string {
  if (
    !validWslDistribution(distribution) ||
    !path.startsWith('/') ||
    path.includes('\\') ||
    hasControlCharacters(path)
  ) {
    throw new Error('Choose a WSL distribution and an absolute Linux folder path.');
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  return `\\\\wsl.localhost\\${distribution}\\${parts.join('\\')}`;
}

export function editorPath(root: string, path: string): string {
  const remote = parseWslPath(root);
  const file = parseWslPath(path);
  if (!remote || !file) {
    return path;
  }
  if (remote.distribution.toLowerCase() !== file.distribution.toLowerCase()) {
    throw new Error('The file belongs to another WSL distribution.');
  }
  return file.path;
}

export function hostPath(root: string, path: string): string {
  const remote = parseWslPath(root);
  return remote && path.startsWith('/') && !path.startsWith('//')
    ? wslHostPath(remote.distribution, path)
    : path;
}

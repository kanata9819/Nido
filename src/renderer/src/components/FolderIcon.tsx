import {
  Folder,
  FolderArchive,
  FolderCheck,
  FolderClock,
  FolderCode,
  FolderCog,
  FolderGit2,
  FolderLock,
  FolderOpen,
  FolderTree,
  type LucideIcon
} from 'lucide-react';

const folderKinds: [RegExp, LucideIcon, string][] = [
  [/^(src|source|lib|include|crate|crates)$/, FolderCode, '#9fc68e'],
  [/^(test|tests|__tests__|spec|specs)$/, FolderCheck, '#76c5b5'],
  [/^(log|logs|logger)$/, FolderClock, '#dcdcaa'],
  [/^(config|configs|settings|\.config|\.vscode|\.codex)$/, FolderCog, '#b6a2d8'],
  [/^(\.git|\.github|\.gitlab)$/, FolderGit2, '#e59277'],
  [/^(node_modules|vendor|target|build|dist|out)$/, FolderArchive, '#d9b777'],
  [/^(components|views|screens|screen)$/, FolderTree, '#e59277'],
  [/^(const|consts|constants)$/, FolderLock, '#80b9d9']
];

export default function FolderIcon({
  path,
  expanded
}: {
  path: string;
  expanded: boolean;
}): React.JSX.Element {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || '';
  const kind = folderKinds.find(([pattern]) => pattern.test(name));
  const Icon = kind?.[1] || (expanded ? FolderOpen : Folder);
  return (
    <Icon size={15} aria-hidden="true" style={{ color: kind?.[2] || '#8fa6af', flexShrink: 0 }} />
  );
}

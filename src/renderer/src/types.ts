export type Panel = 'commands' | 'workspaces' | 'files' | 'buffers' | 'settings' | 'folders' | 'git' | null;

export interface Item {
  key: string;
  title: string;
  detail: string;
  run: () => void;
}

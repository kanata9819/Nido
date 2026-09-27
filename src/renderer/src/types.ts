export type Panel = 'commands' | 'workspaces' | 'files' | 'buffers' | 'settings' | 'folders' | null;

export interface Item {
  key: string;
  title: string;
  detail: string;
  run: () => void;
}

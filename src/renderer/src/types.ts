export type Panel =
    | 'commands'
    | 'workspaces'
    | 'files'
    | 'buffers'
    | 'settings'
    | 'folders'
    | 'git'
    | 'problems'
    | null;

export interface Item {
    severity?: number;
    key: string;
    title: string;
    detail: string;
    run: () => void;
}

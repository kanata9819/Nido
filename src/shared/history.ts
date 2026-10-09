export const historyLimits = {
    fileBytes: 1024 * 1024,
    lines: 20000,
    versions: 20,
    historyBytes: 8 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    files: 200
} as const;

export interface HistoryContent {
    text: string;
    endOfLine: boolean;
    fileformat: 'unix' | 'dos' | 'mac';
}

export interface HistoryVersion {
    id: string;
    timestamp: number;
    kind: 'saved' | 'draft' | 'restored';
    bytes: number;
    lines: number;
}

export interface HistorySnapshot extends HistoryContent {
    path: string;
    buffer: number;
    tick: number;
    modified: boolean;
}

export type HistoryToken = [buffer: number, tick: number, fileformat: string, endOfLine: boolean];

export interface HistoryList {
    path: string;
    versions: HistoryVersion[];
}

export interface HistoryPreview {
    path: string;
    version: HistoryVersion;
    token: string;
    diff: string;
    identical: boolean;
}

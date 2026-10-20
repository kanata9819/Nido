export interface SearchOptions {
    caseSensitive: boolean;
    regex: boolean;
    wholeWord: boolean;
    folder: string;
}

export const defaultSearchOptions: SearchOptions = {
    caseSensitive: true,
    regex: false,
    wholeWord: false,
    folder: ''
};

export interface ReplacementPreview {
    token: string;
    count: number;
    files: { path: string; count: number; before: string; after: string }[];
}

export interface ReplacementResult {
    count: number;
    files: number;
}

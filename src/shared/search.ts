/** Options for workspace-wide text search. */
export interface SearchOptions {
	caseSensitive: boolean;
	regex: boolean;
	wholeWord: boolean;
	/** Limits the search to this folder, relative to the workspace root. Empty searches everything. */
	folder: string;
}

export const defaultSearchOptions: SearchOptions = {
	caseSensitive: true,
	regex: false,
	wholeWord: false,
	folder: ''
};

/** What a workspace-wide replacement would change, shown before it is applied. */
export interface ReplacementPreview {
	/** Identifies the search results the preview was made from; applying it checks the token. */
	token: string;
	count: number;
	files: { path: string; count: number; before: string; after: string }[];
}

/** How many matches and files a replacement changed. */
export interface ReplacementResult {
	count: number;
	files: number;
}

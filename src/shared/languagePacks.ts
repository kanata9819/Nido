// Language packs add language servers (LSP) and runtimes to Nido. Each pack is a folder with a
// manifest; bundled packs ship with Nido, and users can install their own.

/** A language or tool a pack offers, as shown on the Extensions page. */
export interface LanguagePackLanguage {
	id: string;
	title: string;
	mark: string;
	category: 'tools' | 'runtimes';
	extensions: string;
	description: string;
	keywords?: string;
	requirement?: string;
	setup?: string;
	command?: string;
}

/** The pack's manifest file, describing the language server it starts. */
export interface LanguagePackManifest {
	schemaVersion: 1;
	id: string;
	version: string;
	title: string;
	description: string;
	category?: 'language' | 'other';
	filetypes: string[];
	serverName: string;
	/** Command that starts the language server; `commands` overrides it per platform. */
	command?: string[];
	commands?: { win32?: string[]; linux?: string[] };
	/** Files whose folder is treated as the project root, such as package.json. */
	rootMarkers?: string[];
	settings?: Record<string, unknown>;
	initOptions?: Record<string, unknown>;
	setup?: string;
	languages?: LanguagePackLanguage[];
	/** Built-in Lua adapter that adds language-specific behavior beyond plain LSP. */
	adapter?: 'typescript' | 'deno' | 'rust';
}

/** A manifest found on disk; `bundled` packs ship with Nido. */
export interface LanguagePackDefinition extends LanguagePackManifest {
	bundled: boolean;
}

/** Every discovered pack, the ones the user disabled, and manifests that failed to load. */
export interface LanguagePackConfiguration {
	packs: LanguagePackDefinition[];
	disabled: string[];
	errors: string[];
}

/** Whether a pack's language server is running in a workspace. */
export interface LanguagePackRuntime {
	id: string;
	status: 'disabled' | 'ready' | 'starting' | 'running' | 'missing' | 'error';
	message?: string;
}

/** Packs merged with their enabled state and runtime status, for the Extensions page. */
export interface LanguagePackSnapshot {
	packs: (LanguagePackDefinition & {
		enabled: boolean;
		status: LanguagePackRuntime['status'];
		message?: string;
	})[];
	errors: string[];
}

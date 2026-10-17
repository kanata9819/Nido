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

export interface LanguagePackManifest {
    schemaVersion: 1;
    id: string;
    version: string;
    title: string;
    description: string;
    filetypes: string[];
    serverName: string;
    command?: string[];
    commands?: { win32?: string[]; linux?: string[] };
    rootMarkers?: string[];
    settings?: Record<string, unknown>;
    initOptions?: Record<string, unknown>;
    setup?: string;
    languages?: LanguagePackLanguage[];
    adapter?: 'typescript' | 'deno' | 'rust';
}

export interface LanguagePackDefinition extends LanguagePackManifest {
    bundled: boolean;
}

export interface LanguagePackConfiguration {
    packs: LanguagePackDefinition[];
    disabled: string[];
    errors: string[];
}

export interface LanguagePackRuntime {
    id: string;
    status: 'disabled' | 'ready' | 'starting' | 'running' | 'missing' | 'error';
    message?: string;
}

export interface LanguagePackSnapshot {
    packs: (LanguagePackDefinition & {
        enabled: boolean;
        status: LanguagePackRuntime['status'];
        message?: string;
    })[];
    errors: string[];
}

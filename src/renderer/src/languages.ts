export type LanguageCategory = 'tools' | 'runtimes' | 'preview' | 'syntax';

export interface SupportedLanguage {
    id: string;
    title: string;
    mark: string;
    category: LanguageCategory;
    extensions: string;
    description: string;
    keywords?: string;
    requirement?: string;
    setup?: string;
    command?: string;
}

export const languageCategories: { id: LanguageCategory; title: string; description?: string }[] = [
    { id: 'tools', title: 'Code intelligence' },
    {
        id: 'runtimes',
        title: 'Runtimes',
        description:
            'TypeScript and JavaScript project support. Install the runtime separately to run your code in the terminal.'
    },
    { id: 'preview', title: 'Preview' },
    {
        id: 'syntax',
        title: 'Syntax highlighting',
        description:
            'These common languages include highlighting and editing. Completion, diagnostics and symbol navigation are not configured.'
    }
];

const codeIntelligence =
    'Completion, diagnostics, hover, definitions, references, rename, formatting and code actions.';

const syntaxLanguages: Pick<SupportedLanguage, 'id' | 'title' | 'mark' | 'extensions'>[] = [
    { id: 'python', title: 'Python', mark: 'Py', extensions: '.py' },
    { id: 'go', title: 'Go', mark: 'Go', extensions: '.go' },
    { id: 'c-cpp', title: 'C / C++', mark: 'C', extensions: '.c · .h · .cpp · .hpp' },
    { id: 'html-css', title: 'HTML / CSS', mark: '<>', extensions: '.html · .css' },
    { id: 'json', title: 'JSON', mark: '{}', extensions: '.json' },
    { id: 'lua', title: 'Lua', mark: 'Lua', extensions: '.lua' },
    { id: 'zig', title: 'Zig', mark: 'Z', extensions: '.zig' }
];

// Match the language servers configured in resources/nido and the bundled runtime.
export const supportedLanguages: SupportedLanguage[] = [
    {
        id: 'typescript',
        title: 'TypeScript',
        mark: 'TS',
        category: 'tools',
        extensions: '.ts · .tsx',
        keywords: 'React TSX',
        description: codeIntelligence,
        setup: 'Language server included. Uses project TypeScript when available, with a bundled fallback.'
    },
    {
        id: 'javascript',
        title: 'JavaScript',
        mark: 'JS',
        category: 'tools',
        extensions: '.js · .jsx · .mjs · .cjs',
        keywords: 'React JSX',
        description: codeIntelligence,
        setup: 'Language server included. JSX is supported without an extra plugin.'
    },
    {
        id: 'rust',
        title: 'Rust',
        mark: 'Rs',
        category: 'tools',
        extensions: '.rs',
        description: codeIntelligence,
        requirement: 'Requires Rust',
        setup: 'Uses your Rust toolchain. Install Rust, then add these components. Run and debug are also supported.',
        command: 'rustup component add rust-analyzer rust-src rustfmt'
    },
    {
        id: 'node',
        title: 'Node.js',
        mark: 'N',
        category: 'runtimes',
        extensions: 'TypeScript · JavaScript',
        keywords: 'npm package.json',
        description:
            'TypeScript and JavaScript projects use the included language server. Run scripts and package commands in the terminal.',
        requirement: 'Requires Node.js',
        setup: 'Language tools work out of the box. Running your project requires Node.js on PATH.'
    },
    {
        id: 'deno',
        title: 'Deno',
        mark: 'D',
        category: 'runtimes',
        extensions: 'TypeScript · JavaScript',
        keywords: 'deno.json deno.jsonc deno.lock .ts .tsx .js .jsx .mts .mjs',
        description: codeIntelligence,
        requirement: 'Requires Deno',
        setup: 'Uses your installed Deno. Projects with deno.json, deno.jsonc or deno.lock are detected automatically.',
        command: 'winget install --id DenoLand.Deno -e'
    },
    {
        id: 'markdown',
        title: 'Markdown',
        mark: 'Md',
        category: 'preview',
        extensions: '.md · .markdown',
        description:
            'Syntax highlighting and a live preview of unsaved edits. Open the preview with Ctrl+Shift+V.'
    },
    ...syntaxLanguages.map((language): SupportedLanguage => ({
        ...language,
        category: 'syntax',
        description: 'Built-in syntax highlighting only.'
    }))
];

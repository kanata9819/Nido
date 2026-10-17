import typescriptPack from '../../../resources/nido/language-packs/typescript/pack.json';
import rustPack from '../../../resources/nido/language-packs/rust/pack.json';
import denoPack from '../../../resources/nido/language-packs/deno/pack.json';

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
    ...(typescriptPack.languages as SupportedLanguage[]),
    ...(rustPack.languages as SupportedLanguage[]),
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
    ...(denoPack.languages as SupportedLanguage[]),
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

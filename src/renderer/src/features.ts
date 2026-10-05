export type FeatureCategory = 'editor' | 'workspace' | 'tools';

export interface BuiltinFeature {
    id: string;
    category: FeatureCategory;
    title: string;
    description: string;
    shortcut?: string;
}

export const featureCategories: { id: FeatureCategory; title: string }[] = [
    { id: 'editor', title: 'Editing' },
    { id: 'workspace', title: 'Projects and files' },
    { id: 'tools', title: 'Tools and appearance' }
];

export const builtinFeatures: BuiltinFeature[] = [
    {
        id: 'vim-editing',
        category: 'editor',
        title: 'Vim editing',
        description: 'Edit with Neovim modes, motions, registers and undo.'
    },
    {
        id: 'completion',
        category: 'editor',
        title: 'Completion and diagnostics',
        description: 'Get code suggestions and review errors, warnings and hints.',
        shortcut: 'Ctrl+Space'
    },
    {
        id: 'sticky-scroll',
        category: 'editor',
        title: 'Sticky Scroll',
        description: 'Keep enclosing functions and types visible while scrolling.',
        shortcut: 'Alt+Shift+S'
    },
    {
        id: 'code-guides',
        category: 'editor',
        title: 'Bracket and indentation guides',
        description: 'Follow nested code with colored brackets and indentation guides.'
    },
    {
        id: 'editorconfig',
        category: 'editor',
        title: 'EditorConfig',
        description: 'Apply project indentation, line endings and save rules.'
    },
    {
        id: 'workspaces',
        category: 'workspace',
        title: 'Workspaces',
        description: 'Switch between independent sessions, save favorites and restore open files.',
        shortcut: 'Ctrl+Shift+N'
    },
    {
        id: 'explorer',
        category: 'workspace',
        title: 'File explorer',
        description: 'Create, rename, copy, move and recycle files from the keyboard.',
        shortcut: 'Space e'
    },
    {
        id: 'file-search',
        category: 'workspace',
        title: 'File search',
        description: 'Find project files and switch between open buffers.',
        shortcut: 'Ctrl+P'
    },
    {
        id: 'git',
        category: 'workspace',
        title: 'Source control',
        description: 'Review diffs, stage changes, commit and switch branches. Requires Git.',
        shortcut: 'Ctrl+Shift+G'
    },
    {
        id: 'languages',
        category: 'tools',
        title: 'Rust and TypeScript language tools',
        description:
            'Use definitions, rename, formatting and code actions. Rust uses your installed toolchain.',
        shortcut: 'F12'
    },
    {
        id: 'references',
        category: 'tools',
        title: 'References and documentation',
        description: 'Browse symbol references and syntax-highlighted documentation.',
        shortcut: 'Shift+F12 / K'
    },
    {
        id: 'rust-debugger',
        category: 'tools',
        title: 'Rust run and debug',
        description:
            'Run main functions and tests, set breakpoints, inspect variables and step through Rust. Requires the Rust toolchain.',
        shortcut: 'gR / gD'
    },
    {
        id: 'terminal',
        category: 'tools',
        title: 'Terminal',
        description: 'Use a workspace terminal or a standalone shell session.',
        shortcut: 'Ctrl+@'
    },
    {
        id: 'markdown',
        category: 'tools',
        title: 'Markdown preview',
        description: 'Preview Markdown using the current unsaved edits.',
        shortcut: 'Ctrl+Shift+V'
    },
    {
        id: 'appearance',
        category: 'tools',
        title: 'Themes and interface settings',
        description:
            'Choose Dark Modern or Acrylic, adjust fonts and switch between English and Japanese.',
        shortcut: 'Space ,'
    },
    {
        id: 'updates',
        category: 'tools',
        title: 'App updates',
        description:
            'Check for releases, download updates and restart after saving. Available in the installed Windows app.'
    }
];

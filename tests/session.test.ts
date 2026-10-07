import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
    mkdtemp,
    mkdir,
    readFile,
    realpath,
    rm,
    writeFile,
    rename,
    symlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session';
import { Grid, vimKey } from '../src/renderer/src/grid';
import { accumulateScroll, scrollOffset } from '../src/renderer/src/scroll';
import { readFavorites, readLayout, writeFavorites, writeLayout } from '../src/main/persistence';
import { fileDecorations, gitFileKey } from '../src/renderer/src/fileDecorations';
import type { NidoEvent, Redraw } from '../src/shared/types';
import { emptyNeovimUI } from '../src/shared/neovimUI';

test('input mode queries observe preceding queued keys before following text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-input-mode-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        const opening = session.input('i');
        const mode = session.inputMode();
        const text = session.input('Unsaved heading<Esc>');
        await opening;
        assert.equal(await mode, 'i');
        await text;
        assert.equal(await session.inputMode(), 'n');
        assert.equal(await session.client.request('nvim_get_current_line', []), 'Unsaved heading');
        await session.input('0d');
        assert.match(await session.inputMode(), /^no/);
        await session.input('w');
        assert.equal(await session.client.request('nvim_get_current_line', []), 'heading');
        await session.input('0r');
        assert.equal(await session.inputMode(), 'R');
        await session.input(' ');
        assert.equal(await session.client.request('nvim_get_current_line', []), ' eading');
    } finally {
        await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('favorite storage preserves entries independently and rejects invalid data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-favorites-store-'));
    const path = join(root, 'favorites.json');
    try {
        assert.deepEqual(await readFavorites(path), []);
        const favorites = [{ root, name: 'Project', kind: 'editor' as const }];
        await writeFavorites(path, favorites);
        await writeLayout(join(root, 'workspaces.json'), {
            version: 1,
            workspaces: [],
            active: 0
        });
        assert.deepEqual(await readFavorites(path), favorites);
        await writeFavorites(path, []);
        assert.deepEqual(await readFavorites(path), []);
        for (const invalid of [
            null,
            {},
            [{ root: 'relative', name: 'X', kind: 'editor' }],
            [{ root, name: 'X', kind: 'invalid' }],
            [{ root, kind: 'editor' }]
        ]) {
            await writeFile(path, JSON.stringify(invalid));
            await assert.rejects(readFavorites(path), /Invalid favorite workspace data/);
        }
        await writeFile(path, '{broken');
        await assert.rejects(readFavorites(path), SyntaxError);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('empty definition and reference results become native notices without grid messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-notices-'));
    let session: Session | undefined;
    const notices: Extract<NidoEvent, { type: 'notification' }>[] = [];
    try {
        session = await Session.create(root, (event) => {
            if (event.type === 'notification') notices.push(event);
        });
        await session.client.request('nvim_exec_lua', [
            `local original = vim.lsp.get_clients
local client = {offset_encoding = 'utf-16', request = function(_, _, _, callback)
  callback(nil, nil)
  return true
end}
vim.lsp.get_clients = function() return {client} end
local ok, err = pcall(function()
  vim.lsp.buf.definition()
  require('nido_references').find()
end)
vim.lsp.get_clients = original
assert(ok, err)
vim.notify('Server unavailable', vim.log.levels.WARN, {title = 'Language server'})
vim.notify('Debug detail', vim.log.levels.DEBUG)
assert(vim.api.nvim_get_mode().mode ~= 'r')`,
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.ok(
            notices.some(
                (notice) => notice.message === 'No locations found' && notice.severity === 'info'
            )
        );
        assert.ok(
            notices.some(
                (notice) => notice.title === 'References' && /No references/.test(notice.message)
            )
        );
        assert.ok(
            notices.some(
                (notice) => notice.severity === 'warning' && notice.message === 'Server unavailable'
            )
        );
        assert.ok(!notices.some((notice) => notice.message === 'Debug detail'));
        assert.doesNotMatch(
            JSON.stringify(
                await session.client.request('nvim_exec2', ['messages', { output: true }])
            ),
            /No locations found|No references found/
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('gf reports missing files through native notices and preserves counted path searches and jumps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-goto-file-'));
    const grid = new Grid();
    const notices: Extract<NidoEvent, { type: 'notification' }>[] = [];
    let session: Session | undefined;
    try {
        await mkdir(join(root, 'first'));
        await mkdir(join(root, 'second'));
        await writeFile(join(root, 'notes.txt'), 'event.preventDefault\ntarget\n');
        await writeFile(join(root, 'first', 'target.txt'), 'first match\n');
        await writeFile(join(root, 'second', 'target.txt'), 'second match\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'notification') notices.push(event);
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.openFile('notes.txt');
        await session.client.request('nvim_exec_lua', [
            "vim.opt.path = {'first', 'second'}; vim.opt.suffixesadd = {'.txt'}",
            []
        ]);
        await session.input('gg0gf');
        await session.client.request('nvim_eval', ['1']);
        assert.deepEqual(
            notices.map(({ title, message, severity }) => ({ title, message, severity })),
            [
                {
                    title: 'File navigation',
                    message: 'E447: Can\'t find file "event.preventDefault" in path',
                    severity: 'error'
                }
            ]
        );
        assert.equal(await session.client.request('nvim_eval', ["expand('%:t')"]), 'notes.txt');
        assert.equal(await session.client.request('nvim_eval', ['mode(1)']), 'n');
        assert.deepEqual(await session.client.request('nvim_win_get_cursor', [0]), [1, 0]);
        assert.match(
            grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n'),
            /event\.preventDefault/
        );
        assert.doesNotMatch(
            grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n'),
            /E447|Can't find file|Press ENTER/
        );
        assert.doesNotMatch(
            JSON.stringify(
                await session.client.request('nvim_exec2', ['messages', { output: true }])
            ),
            /E447|Can't find file/
        );
        await session.input('j02gf');
        assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'second match');
        await session.input('<C-o>');
        assert.equal(await session.client.request('nvim_eval', ["expand('%:t')"]), 'notes.txt');
        await session.input('gf');
        assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'first match');
        assert.equal(notices.length, 1);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('source previews use Neovim syntax colors without changing editor buffers or starting FileType plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-source-colors-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            `vim.g.preview_filetypes = 0
vim.api.nvim_create_autocmd('FileType', {callback=function() vim.g.preview_filetypes = vim.g.preview_filetypes + 1 end})`,
            []
        ]);
        const snapshot =
            'return {vim.api.nvim_list_bufs(), vim.api.nvim_get_current_buf(), vim.bo.modified}';
        const buffers = await session.client.request('nvim_exec_lua', [snapshot, []]);
        for (const [path, source] of [
            ['sample.rs', 'fn main() {\n/* comment\n日本語 🐱 */\nlet message = "<script>";\n}'],
            [
                'sample.ts',
                'const message = "日本語 🐱";\n/* comment\ncontinued */\nexport function run() { return 42; }'
            ],
            ['sample.tsx', 'const view = <div title="日本語">Hello</div>;']
        ]) {
            const [before, after] = await session.highlightSources(path, source, source);
            assert.equal(
                before.map((line) => line.map((span) => span.text).join('')).join('\n'),
                source
            );
            assert.deepEqual(after, before);
            assert.ok(
                new Set(before.flat().map((span) => span.color)).size > 1,
                `${path} needs syntax colors`
            );
            if (!path.endsWith('.tsx')) {
                assert.equal(
                    before[1][0].color,
                    before[2][0].color,
                    `${path} keeps multiline comment state`
                );
            }
        }
        const plain = await session.highlightSources(
            'unknown.nido-unknown',
            '',
            'plain <script>日本語</script>'
        );
        assert.deepEqual(plain[0], []);
        assert.equal(
            plain[1][0].map((span) => span.text).join(''),
            'plain <script>日本語</script>'
        );
        const longSource =
            'fn main() {}\n' +
            Array.from({ length: 150 }, (_, i) => `// ${i} ${'long diff line '.repeat(20)}`).join(
                '\n'
            );
        const longPreview = await session.highlightSources('main.rs', '', longSource);
        assert.equal(
            longPreview[1].map((line) => line.map((span) => span.text).join('')).join('\n'),
            longSource
        );
        assert.deepEqual(await session.client.request('nvim_exec_lua', [snapshot, []]), buffers);
        assert.equal(await session.client.request('nvim_eval', ['g:preview_filetypes']), 0);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

test('TypeScript import bindings and type-only keywords use the reference theme colors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-import-colors-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const source = "import { run } from './lib';\nimport type {\n  Shape\n} from './lib';";
        for (const path of ['sample.ts', 'sample.tsx']) {
            const [lines] = await session.highlightSources(path, source, '');
            const ink = (row: number, word: string): string | undefined =>
                lines[row].find((span) => span.text.includes(word))?.color;
            assert.equal(ink(0, 'import'), '#c586c0', path);
            assert.equal(ink(0, 'run'), '#9cdcfe', path);
            assert.equal(ink(1, 'type'), '#569cd6', path);
            assert.equal(ink(2, 'Shape'), '#4ec9b0', path);
        }
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('Dark Modern syntax colors match the official palette in TypeScript, TSX and Rust previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-dark-modern-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const cases: [string, string, [number, string, string][]][] = [
            [
                'sample.ts',
                '/** Documentation */\nfunction pick<T>(value: T): T { return value; }\nconst upper = "ok".toUpperCase();\nconst pattern = /hello/;\nconst escaped = "a\\nb";\nconst length = upper.length;\nclass Example { apply() { this.busy = true; } }',
                [
                    [0, 'Documentation', '#6a9955'],
                    [1, 'pick', '#dcdcaa'],
                    [1, 'T', '#4ec9b0'],
                    [1, 'value', '#9cdcfe'],
                    [1, 'return', '#c586c0'],
                    [2, 'toUpperCase', '#dcdcaa'],
                    [3, 'hello', '#d16969'],
                    [4, '\\n', '#d7ba7d'],
                    [5, 'length', '#9cdcfe'],
                    [6, 'this', '#569cd6']
                ]
            ],
            [
                'sample.tsx',
                'const view = <div title="ok">Hello</div>;\nclass Example { apply() { this.busy = true; } }\nconst component = <FeaturesPage onClose={focusEditor} />;\nconst nested = <Example><span /></Example>;',
                [
                    [0, 'div', '#569cd6'],
                    [0, 'title', '#9cdcfe'],
                    [0, 'ok', '#ce9178'],
                    [1, 'this', '#569cd6'],
                    [0, '</', '#808080'],
                    [2, 'FeaturesPage', '#dcdcaa'],
                    [2, '/>', '#808080'],
                    [3, '/>', '#808080']
                ]
            ],
            [
                'sample.rs',
                'fn greet(value: u32) -> bool { true }\nlet text: &str = "ok";\n// Documentation\n#[cfg(test)]\n#[test]\nfn example() { assert!(true); panic!("oops"); dbg!(text); }\nfn borrow<\'a>(value: &\'a str) -> &\'a str { value }\nfn fallible() { work()?; }',
                [
                    [0, 'fn', '#569cd6'],
                    [0, 'greet', '#dcdcaa'],
                    [0, 'u32', '#4ec9b0'],
                    [0, 'bool', '#4ec9b0'],
                    [0, 'true', '#569cd6'],
                    [1, 'str', '#4ec9b0'],
                    [1, 'ok', '#ce9178'],
                    [2, 'Documentation', '#6a9955'],
                    [1, '&', '#d4d4d4'],
                    [3, 'cfg', '#cccccc'],
                    [4, 'test', '#cccccc'],
                    [5, 'assert!', '#dcdcaa'],
                    [5, 'panic!', '#dcdcaa'],
                    [5, 'dbg!', '#dcdcaa'],
                    [6, "'a", '#4ec9b0'],
                    [7, '?', '#d4d4d4']
                ]
            ]
        ];
        for (const [path, source, colors] of cases) {
            const [lines] = await session.highlightSources(path, source, '');
            for (const [row, word, color] of colors) {
                assert.equal(
                    lines[row].find((span) => span.text.includes(word))?.color,
                    color,
                    `${path}: ${word}`
                );
            }
        }
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                "return vim.api.nvim_get_hl(0, {name='Normal', link=false}).fg",
                []
            ]),
            0xcccccc
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('hover without an LSP never opens help and successful saves stay quiet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-hover-'));
    let session: Session | undefined;
    const hovers: string[] = [];
    try {
        await writeFile(join(root, 'sample.ts'), 'const state = 1;\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'hover') hovers.push(event.markdown);
        });
        await session.openFile('sample.ts');
        await session.client.request('nvim_exec_lua', [
            `assert(vim.g.nido_channel, 'missing channel')
vim.lsp.enable('typescript', false)
for _, key in ipairs({'K', '<C-k>'}) do
  local mapping = vim.fn.maparg(key, 'n', false, true)
  assert(type(mapping.callback) == 'function')
  mapping.callback()
  assert(#vim.api.nvim_list_wins() == 1)
  assert(vim.bo.filetype == 'typescript')
end
local calls = 0
local get_clients, request_all = vim.lsp.get_clients, vim.lsp.buf_request_all
vim.lsp.get_clients = function() return {{}} end
vim.lsp.buf_request_all = function(buf, method, params, callback)
  calls = calls + 1
  assert(method == 'textDocument/hover' and type(params) == 'function')
  callback({[1]={result={contents={kind='markdown', value='A type description'}}}})
end
vim.fn.maparg('K', 'n', false, true).callback()
local pending
vim.lsp.buf_request_all = function(_, _, _, callback) pending = callback end
vim.fn.maparg('K', 'n', false, true).callback()
vim.api.nvim_win_set_cursor(0, {1, 1})
pending({[1]={result={contents={kind='markdown', value='Stale type description'}}}})
vim.lsp.get_clients, vim.lsp.buf_request_all = get_clients, request_all
assert(calls == 1)
assert(#vim.api.nvim_list_wins() == 1)
vim.cmd('messages clear')`,
            []
        ]);
        await session.save(false);
        assert.ok(hovers.includes('A type description'), JSON.stringify(hovers));
        assert.ok(!hovers.includes('Stale type description'));
        assert.equal(await readFile(join(root, 'sample.ts'), 'utf8'), 'const state = 1;\n');
        assert.doesNotMatch(
            JSON.stringify(
                await session.client.request('nvim_exec2', ['messages', { output: true }])
            ),
            /written|\[w\]/
        );
        await session.input('AX<Esc>');
        await session.client.request('nvim_eval', ['1']);
        await session.input('u');
        assert.equal(await session.client.request('nvim_eval', ['getline(1)']), 'const state = 1;');
        await session.input('<C-r>');
        assert.equal(
            await session.client.request('nvim_eval', ['getline(1)']),
            'const state = 1;X'
        );
        assert.doesNotMatch(
            JSON.stringify(
                await session.client.request('nvim_exec2', ['messages', { output: true }])
            ),
            /before #|after #/
        );
        await session.client.request('nvim_exec_lua', ['vim.bo.readonly = true', []]);
        await assert.rejects(session.save(false), /readonly|E45/);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

test('gutter numbers and current-line colors stay based on the edit anchor during pixel scrolling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-relative-scroll-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'lines.txt'),
            Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.attach(80, 24);
        await session.openFile('lines.txt');
        await session.setRelativeLineNumbers(true);
        await session.input('80Gzz');
        const checkGutter = (anchor: number, relative: boolean): void => {
            let checked = 0;
            for (const row of grid.cells) {
                const text = row.map((cell) => cell.text).join('');
                const match = text.match(/^\s*(\d+)\s+line (\d+)\s*$/);
                if (!match) continue;
                const line = Number(match[2]);
                assert.equal(
                    Number(match[1]),
                    !relative || line === anchor ? line : Math.abs(line - anchor),
                    `gutter for line ${line}`
                );
                const first = text.indexOf(match[1]);
                for (const cell of row.slice(first, first + match[1].length)) {
                    assert.equal(
                        grid.highlights.get(cell.highlight)?.foreground,
                        line === anchor ? 0xc6c6c6 : 0x858585,
                        `gutter color for line ${line}`
                    );
                }
                checked++;
            }
            assert.ok(checked > 10);
        };
        for (const relative of [true, false, true]) {
            await session.setRelativeLineNumbers(relative);
            await new Promise((done) => setTimeout(done, 30));
            checkGutter(80, relative);
        }
        for (const [lines, relative] of [
            [0.25, true],
            [26.25, true],
            [-24.5, true],
            [0.1, false],
            [0.1, true]
        ] as const) {
            await session.setRelativeLineNumbers(relative);
            await session.scroll(lines, false, true);
            await new Promise((done) => setTimeout(done, 30));
            checkGutter(80, relative);
        }
        await session.input('j');
        await session.client.request('nvim_eval', ['1']);
        assert.equal(await session.client.request('nvim_eval', ["line('.')"]), 81);
        assert.equal(await session.client.request('nvim_eval', ['&statuscolumn']), '');
        await new Promise((done) => setTimeout(done, 30));
        checkGutter(81, true);
        await session.scroll(30, false, true);
        await session.scroll(1, true, true);
        assert.equal(await session.client.request('nvim_eval', ['&statuscolumn']), '');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('wheel scrolling can retain the edit position and resumes input and paste at the anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-anchor-'));
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'lines.txt'),
            Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
        );
        session = await Session.create(root, () => {});
        await session.openFile('lines.txt');
        await session.client.request('nvim_exec_lua', [
            'vim.api.nvim_win_set_cursor(0, {20, 0})',
            []
        ]);
        await session.scroll(60, false);
        assert.deepEqual(
            await session.client.request('nvim_exec_lua', [
                "return require('nido_scroll').cursor()",
                []
            ]),
            [20, 0]
        );
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                "return require('nido_scroll').screen_cursor().row",
                []
            ]),
            -1
        );
        await session.input('iX<Esc>');
        await new Promise((done) => setTimeout(done, 50));
        assert.equal(await session.client.request('nvim_eval', ['getline(20)']), 'Xline 20');
        await session.scroll(60, false);
        await session.paste('Y');
        assert.match(String(await session.client.request('nvim_eval', ['getline(20)'])), /Y/);
        await session.scroll(60, true);
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                "return require('nido_scroll').cursor()",
                []
            ]),
            null
        );
        assert.ok(Number(await session.client.request('nvim_eval', ["line('.')"])) > 20);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('keyboard page scrolling reveals the last row hidden by pixel-scroll overscan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-page-end-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            'vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 46)))',
            []
        ]);
        for (const rows of [24, 25, 44, 45]) {
            await session.resize(80, rows);
            for (const key of ['<C-d>', '2<C-d>', '<C-f>', '<PageDown>']) {
                await session.input('gg');
                for (let step = 0; step < 46; step++) await session.input(key);
                const screen = Number(
                    await session.client.request('nvim_eval', [
                        "screenpos(win_getid(), line('$'), 1).row"
                    ])
                );
                assert.ok(
                    screen > 0 && screen <= rows - 2,
                    `${key}, ${rows} rows: EOF at screen row ${screen}`
                );
            }
        }
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 45, 46, false, {string.rep('x', 160)})",
            []
        ]);
        await session.input('gg');
        for (let step = 0; step < 46; step++) await session.input('<C-d>');
        const wrappedEnd = Number(
            await session.client.request('nvim_eval', [
                "screenpos(win_getid(), line('$'), 160).row"
            ])
        );
        assert.ok(wrappedEnd > 0 && wrappedEnd <= 43, `wrapped EOF at screen row ${wrappedEnd}`);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('zz centers the cursor in the visible viewport for odd and even grid heights', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-center-'));
    let session: Session | undefined;
    let fraction = 0;
    try {
        session = await Session.create(root, (event) => {
            if (event.type !== 'redraw') return;
            for (const [name, ...calls] of event.events) {
                if (name === 'nido_pixel_scroll') fraction = Number(calls.at(-1)![0]);
            }
        });
        await session.attach(80, 34);
        await session.client.request('nvim_exec_lua', [
            'vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.tbl_map(tostring, vim.fn.range(1, 300)))',
            []
        ]);
        for (const rows of [34, 35, 36, 37]) {
            await session.resize(80, rows);
            await session.scroll(0.3, false, true);
            await session.input('150zz');
            await session.client.request('nvim_eval', ['1']);
            const row = Number(await session.client.request('nvim_eval', ['winline() - 1']));
            assert.equal(row + 0.5 - fraction, (rows - 2) / 2, `grid height ${rows}`);
            assert.equal(await session.client.request('nvim_eval', ["line('.')"]), 150);
            await session.input('gg');
            await session.client.request('nvim_eval', ['1']);
            assert.equal(fraction, 0, 'returning to the first line clears the centering offset');
            await session.input(`${Math.floor((rows - 2) / 2) + 1}zz`);
            await session.client.request('nvim_eval', ['1']);
            assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 1);
            assert.equal(fraction, 0, 'centering near the file start never clips the first line');
        }
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('pixel scrolling publishes the grid, offset and anchored cursor in a single frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-frame-'));
    let session: Session | undefined;
    const frames: Redraw[] = [];
    try {
        await writeFile(
            join(root, 'lines.txt'),
            Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') frames.push(event.events);
        });
        await session.attach(80, 25);
        await session.openFile('lines.txt');
        await session.client.request('nvim_exec_lua', [
            'vim.cmd("normal! 20Gzz"); vim.cmd.redraw()',
            []
        ]);
        frames.length = 0;
        for (const delta of [0.2, 0.9, 0.9, -0.3, -0.8]) {
            await session.scroll(delta, false, true);
            assert.equal(
                frames.length,
                1,
                'no frame may expose an old grid with a new fractional offset'
            );
            const offset = frames[0].find(([name]) => name === 'nido_pixel_scroll')![1];
            assert.deepEqual(
                offset[2],
                await session.client.request('nvim_exec_lua', [
                    "return require('nido_scroll').screen_cursor()",
                    []
                ])
            );
            assert.equal(frames[0].at(-1)![0], 'flush');
            frames.length = 0;
        }
        await Promise.all([session.scroll(0.4, false, true), session.scroll(0.8, false, true)]);
        assert.equal(
            frames.length,
            2,
            JSON.stringify(
                frames.map((frame) =>
                    frame.map(([name, ...calls]) => [
                        name,
                        name === 'nido_pixel_scroll' ? calls : calls.length
                    ])
                )
            )
        );
        assert.ok(
            frames.every(
                (frame) => frame.filter(([name]) => name === 'nido_pixel_scroll').length === 1
            )
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('upward pixel scrolling at the beginning never exposes cached rows or a fractional offset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-start-'));
    let session: Session | undefined;
    const grid = new Grid();
    const frames: Redraw[] = [];
    try {
        await writeFile(
            join(root, 'rows.txt'),
            Array.from({ length: 500 }, (_, index) => `ROW_${index + 1} text`).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') {
                frames.push(event.events);
                grid.apply(event.events);
            }
        });
        await session.attach(80, 25);
        await session.openFile('rows.txt');
        await session.setRelativeLineNumbers(true);
        await session.input('200Gzt');
        await session.prefetchScroll();
        await session.scroll(-1000, false, true);
        await session.prefetchScroll();
        for (const delta of [-0.1, -0.3, -1, -2.5, -0.01]) {
            frames.length = 0;
            await session.scroll(delta, false, true);
            const view = (await session.client.request('nvim_exec_lua', [
                'return vim.fn.winsaveview()',
                []
            ])) as { topline: number; skipcol: number };
            const offsets = frames.flatMap((frame) =>
                frame.flatMap(([name, ...calls]) => (name === 'nido_pixel_scroll' ? calls : []))
            );
            assert.equal(view.topline, 1);
            assert.equal(view.skipcol, 0);
            assert.equal(offsets.at(-1)?.[0], 0, `delta ${delta}: ${JSON.stringify(frames)}`);
            assert.equal(grid.hasUpperRows, false, `delta ${delta}: ${JSON.stringify(frames)}`);
        }
        await session.input('200Gzt');
        await session.prefetchScroll();
        for (let step = 0; step < 180; step++) {
            await session.scroll(-1.3, false, true);
        }
        assert.equal(grid.hasUpperRows, false);
        await session.input('gg');
        await session.client.request('nvim_exec_lua', [
            `local ns = vim.api.nvim_create_namespace('top-test')
            vim.api.nvim_buf_set_extmark(0, ns, 0, 0, {virt_lines={{{'VIRTUAL_GHOST', 'Normal'}}}, virt_lines_above=true})
            vim.fn.winrestview({topline=1, topfill=1}); vim.cmd.redraw()`,
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_clear_namespace(0, vim.api.nvim_create_namespace('top-test'), 0, -1); vim.cmd.redraw()",
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.equal(grid.hasUpperRows, false, 'a decoration redraw is not viewport movement');
        await session.prefetchScroll();
        assert.equal(
            grid.hasUpperRows,
            false,
            'virtual-line redraws at the beginning must not leave stale history'
        );
        // A wrapped continuation of line one still has real content above it.
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 0, 1, false, {string.rep('wrapped ', 60)}); vim.cmd('normal! gg'); vim.cmd.redraw()",
            []
        ]);
        await session.scroll(1.2, false, true);
        const wrappedView = (await session.client.request('nvim_exec_lua', [
            'return vim.fn.winsaveview()',
            []
        ])) as { topline: number; skipcol: number };
        assert.equal(wrappedView.topline, 1);
        assert.ok(wrappedView.skipcol > 0);
        await session.prefetchScroll();
        assert.equal(grid.hasUpperRows, true, 'wrapped line one retains its earlier screen rows');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('scroll prefetch caches upper rows without changing the view, cursor or buffer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-prefetch-'));
    let session: Session | undefined;
    const grid = new Grid();
    const frames: Redraw[] = [];
    try {
        await writeFile(
            join(root, 'lines.txt'),
            Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') {
                grid.apply(event.events);
                frames.push(event.events);
            }
        });
        await session.attach(80, 25);
        await session.openFile('lines.txt');
        await session.input('50Gzt');
        const snapshot = (): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [
                "return {vim.fn.winsaveview(), vim.api.nvim_buf_get_lines(0, 0, -1, false), require('nido_scroll').screen_cursor()}",
                []
            ]);
        for (const detached of [false, true]) {
            if (detached) await session.scroll(0.2, false, true);
            const before = await snapshot();
            const cachedRows = grid.cells.slice();
            const cells = grid.cells.map((row) => row.map((cell) => cell.text).join(''));
            frames.length = 0;
            await session.prefetchScroll();
            assert.deepEqual(await snapshot(), before);
            assert.deepEqual(
                grid.cells.map((row) => row.map((cell) => cell.text).join('')),
                cells
            );
            for (let row = 0; row < grid.rows; row++) {
                assert.equal(
                    grid.cells[row],
                    cachedRows[row],
                    'prefetch reuses unchanged row images'
                );
            }
            assert.equal(
                grid.needsUpperRows,
                false,
                'history reaches BOF without repeated refills'
            );
            assert.equal(
                frames.length,
                1,
                'intermediate view must remain inside one atomic redraw'
            );
            assert.equal(
                grid.hasUpperRows,
                true,
                JSON.stringify(
                    frames.map((frame) =>
                        frame.map(([name, ...calls]) => [
                            name,
                            name === 'grid_scroll' || name === 'nido_scroll' ? calls : calls.length
                        ])
                    )
                )
            );
            for (let i = 0; i < 7; i++) {
                await session.scroll(-1, !detached, true);
                assert.equal(
                    grid.hasUpperRows,
                    true,
                    'successive upward rows reuse the prefetched history'
                );
            }
        }
        await session.input('175Gzt');
        await session.prefetchScroll();
        await session.scroll(-70, true, true);
        assert.equal(grid.hasUpperRows, true, 'an upward page jump retains earlier cached rows');
        assert.equal(grid.needsUpperRows, false, 'the remaining history still reaches BOF');
        await session.input('2');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await session.prefetchScroll();
        await session.input('0G');
        await session.client.request('nvim_eval', ['1']);
        assert.equal(
            ((await session.client.request('nvim_win_get_cursor', [0])) as number[])[0],
            20
        );
        await session.input(':let g:nido_prefetch_check = 4');
        await session.prefetchScroll();
        await session.input('2<CR>');
        assert.equal(await session.client.request('nvim_eval', ['g:nido_prefetch_check']), 42);
        await session.input('i_');
        const inserting = await snapshot();
        frames.length = 0;
        await session.prefetchScroll();
        assert.deepEqual(
            await snapshot(),
            inserting,
            'Insert-mode prefetch preserves the view and text'
        );
        assert.equal(
            ((await session.client.request('nvim_get_mode', [])) as { mode: string }).mode,
            'i'
        );
        assert.equal(
            grid.hasUpperRows,
            true,
            'editing must not permanently disable the upper cache'
        );
        assert.equal(
            frames.flat().filter((event) => event[0] === 'nido_edit').length,
            0,
            'prefetch must not republish an already delivered edit and cancel pending wheel movement'
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('scroll prefetch fills history for wrapped lines without repeated refills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-wrapped-prefetch-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'wrapped.txt'),
            Array.from(
                { length: 1500 },
                (_, i) => `ROW_${i + 1} ${'const value = example(argument); '.repeat(5)}`
            ).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.attach(80, 25);
        await session.openFile('wrapped.txt');
        await session.input('1000Gzt');
        // The bracket scanner runs asynchronously. A later color change correctly invalidates
        // cached row images, so compare reuse only after the initial highlights are ready.
        await session.client.request('nvim_exec_lua', [
            `local namespace = vim.api.nvim_get_namespaces().nido_brackets
assert(vim.wait(3000, function()
  return #vim.api.nvim_buf_get_extmarks(0, namespace, 0, -1, {limit=1}) > 0
end, 10), 'Bracket highlighting did not become ready')
vim.cmd.redraw()`,
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        const before = grid.cells.map((row) => row.map((cell) => cell.text).join(''));
        await session.prefetchScroll();
        assert.deepEqual(
            grid.cells.map((row) => row.map((cell) => cell.text).join('')),
            before
        );
        assert.equal(grid.needsUpperRows, false, 'a wrapped viewport must fill the upper history');
        const images = new Set(grid.cells);
        await session.scroll(-3, false, true);
        assert.equal(grid.needsUpperRows, false, 'small upward deltas must reuse history');
        assert.ok(
            grid.cells.filter((row) => images.has(row)).length > grid.rows / 2,
            'wrapped scrolling must reuse unchanged text images instead of rasterizing the viewport'
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('clipboard sharing switches Vim yank, delete and paste between private and system registers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-clipboard-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const lua = (code: string): Promise<unknown> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        // Exercise the real Vim provider contract without replacing the user's OS clipboard.
        await lua(`
      vim.g.test_clipboard = {{'outside'}, 'V'}
      local copy = function(lines, kind) vim.g.test_clipboard = {lines, kind} end
      local paste = function() return vim.g.test_clipboard end
      vim.g.clipboard = {name='test', copy={['+']=copy, ['*']=copy}, paste={['+']=paste, ['*']=paste}, cache_enabled=0}
      vim.api.nvim_buf_set_lines(0, 0, -1, false, {'first', 'second'})
    `);
        await session.setClipboardSharing(false);
        await lua('vim.cmd("normal! ggyy")');
        assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['outside']);
        await session.setClipboardSharing(true);
        await lua('vim.cmd("normal! ggyy")');
        assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['first', '']);
        await lua('vim.cmd("normal! jdd")');
        assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['second', '']);
        await lua(`vim.g.test_clipboard = {{'pasted'}, 'V'}; vim.cmd('normal! p')`);
        assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
            'first',
            'pasted'
        ]);
        await session.setClipboardSharing(false);
        await lua(
            `vim.cmd('normal! ggyy'); vim.g.test_clipboard = {{'outside again'}, 'V'}; vim.cmd('normal! p')`
        );
        assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
            'first',
            'first',
            'pasted'
        ]);
        assert.deepEqual(await lua('return vim.g.test_clipboard[1]'), ['outside again']);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('split redraw notifications remain invisible until flush and keep scroll metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-redraw-'));
    const frames: Redraw[] = [];
    let session: Session | undefined;
    try {
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') {
                frames.push(event.events);
            }
        });
        await session.client.request('nvim_eval', ['1']);
        frames.length = 0;
        const scroll = [1, 0, 23, 0, 80, -3, 0];
        const first: Redraw = [['grid_line', [1, 0, 0, [['first', 0]]]]];
        const second: Redraw = [['grid_line', [1, 1, 0, [['second', 0]]]]];
        session.client.emit('notification', 'nido:scroll', [scroll]);
        session.client.emit('notification', 'redraw', first);
        session.client.emit('notification', 'redraw', second);
        assert.equal(frames.length, 0);
        session.client.emit('notification', 'redraw', [['flush', []], ...first]);
        assert.deepEqual(frames, [[['nido_scroll', scroll], ...first, ...second, ['flush', []]]]);
        session.client.emit('notification', 'redraw', [['flush', []]]);
        assert.deepEqual(frames[1], [...first, ['flush', []]]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('relative line numbers follow the setting when switching previously opened files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-relative-files-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'first.txt'), 'first\n');
        await writeFile(join(root, 'second.txt'), 'second\n');
        await writeFile(join(root, 'new.txt'), 'new\n');
        session = await Session.create(root, () => {});
        await session.openFile('first.txt');
        await session.openFile('second.txt');
        await session.setRelativeLineNumbers(true);
        await session.openFile('first.txt');
        assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
        await session.openFile('second.txt');
        assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
        await session.openFile('new.txt');
        assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 1);
        await session.setRelativeLineNumbers(false);
        await session.openFile('first.txt');
        assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 0);
        await session.openFile('second.txt');
        assert.equal(await session.client.request('nvim_eval', ['&l:relativenumber']), 0);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('word wrap follows the setting across cached buffers and new windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-word-wrap-'));
    let session: Session | undefined;
    try {
        for (const name of ['first.txt', 'second.txt', 'new.txt']) {
            await writeFile(join(root, name), `${'x'.repeat(400)}WRAP_END\n`);
        }
        session = await Session.create(root, () => {});
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.attach(80, 24);
        await session.openFile('first.txt');
        assert.equal(await lua('return vim.wo.wrap'), true);
        await session.openFile('second.txt');
        await session.setWordWrap(false);
        for (const name of ['first.txt', 'second.txt', 'new.txt']) {
            await session.openFile(name);
            assert.equal(await lua('return vim.wo.wrap'), false, name);
        }
        await lua("vim.cmd('split')");
        assert.equal(await lua('return vim.wo.wrap'), false);
        await session.setWordWrap(true);
        assert.deepEqual(
            await lua(`local result = {}
for _, win in ipairs(vim.api.nvim_list_wins()) do
  table.insert(result, vim.api.nvim_get_option_value('wrap', {win=win}))
end
return result`),
            [true, true]
        );
        await session.openFile('first.txt');
        assert.equal(await lua('return vim.wo.wrap'), true);
        assert.equal(await lua('return #vim.api.nvim_get_current_line()'), 408);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('normal Ctrl+C avoids the Neovim quit hint while command entry remains visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-quit-hint-'));
    const grid = new Grid();
    let ui = emptyNeovimUI();
    let session: Session | undefined;
    try {
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
            if (event.type === 'neovimUI') ui = event.state;
        });
        await session.attach(80, 24);
        await session.input('<C-c>');
        await new Promise((done) => setTimeout(done, 30));
        const text = (): string =>
            grid.cells.map((row) => row.map((cell) => cell.text).join('')).join('\n');
        assert.doesNotMatch(text(), /Type.*:qa.*exit Nvim/);
        await session.input(':echo');
        await new Promise((done) => setTimeout(done, 30));
        assert.doesNotMatch(text(), /:echo/);
        assert.equal(ui.commands[1].firstCharacter, ':');
        assert.equal(ui.commands[1].content.map((chunk) => chunk[1]).join(''), 'echo');
        await session.input('<C-c>');
        await session.client.request('nvim_eval', ['1']);
        assert.equal(await session.client.request('nvim_eval', ['mode()']), 'n');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('saving keeps the grid cursor still and viewport progress updates without Vim footer text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-save-cursor-'));
    let session: Session | undefined;
    const frames: Redraw[] = [];
    try {
        await writeFile(
            join(root, 'lines.txt'),
            Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') frames.push(event.events);
        });
        await session.attach(80, 34);
        await session.openFile('lines.txt');
        await session.input('150Gzz');
        await session.client.request('nvim_eval', ['1']);
        const cursor = await session.client.request('nvim_eval', ['[winline()-1, wincol()-1]']);
        frames.length = 0;
        await session.save();
        await session.client.request('nvim_eval', ['1']);
        for (const frame of frames) {
            for (const [name, ...calls] of frame) {
                if (name === 'grid_cursor_goto') {
                    for (const call of calls) assert.deepEqual(call.slice(1), cursor);
                }
            }
        }
        assert.equal(await session.client.request('nvim_eval', ['&ruler || &showcmd']), 0);
        assert.match(String(await session.client.request('nvim_eval', ['&shortmess'])), /F/);
        const middle = session.state.scrollPercent!;
        assert.ok(middle > 0 && middle < 100);
        await session.scroll(8, false, true);
        await new Promise((done) => setTimeout(done, 30));
        assert.ok(
            session.state.scrollPercent! > middle,
            'viewport progress follows scrolling while the edit anchor stays fixed'
        );
        await session.input('gg');
        await new Promise((done) => setTimeout(done, 30));
        assert.equal(session.state.scrollPercent, 0);
        await session.input('G');
        await new Promise((done) => setTimeout(done, 30));
        assert.equal(session.state.scrollPercent, 100);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('save formats before writing only when enabled and a formatter is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-format-save-'));
    let session: Session | undefined;
    try {
        const path = join(root, 'sample.txt');
        await writeFile(path, 'original\n');
        session = await Session.create(root, () => {});
        await session.openFile('sample.txt');
        await session.client.request('nvim_exec_lua', [
            `local get_clients = vim.lsp.get_clients
vim.lsp.get_clients = function(opts)
  if opts and opts.bufnr == 0 and opts.method == 'textDocument/formatting' then
    return { {} }
  end
  return get_clients(opts)
end
vim.lsp.buf.format = function(opts)
  assert(opts.async == false and opts.timeout_ms == 3000)
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {'formatted'})
end`,
            []
        ]);
        await session.save(false);
        assert.equal(await readFile(path, 'utf8'), 'original\n');
        await session.save(true);
        assert.equal(await readFile(path, 'utf8'), 'formatted\n');
        await session.client.request('nvim_exec_lua', [
            "vim.lsp.get_clients = function() return {} end; vim.api.nvim_buf_set_lines(0, 0, -1, false, {'no formatter'})",
            []
        ]);
        await session.save(true);
        assert.equal(await readFile(path, 'utf8'), 'no formatter\n');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('file decorations propagate to parents and prioritize errors without losing Git status', () => {
    const git = { 'c:/repo/src/deep/a.rs': { code: 'M', title: 'Git: Modified' } };
    const result = fileDecorations('C:\\repo', git, {
        'C:\\repo\\src\\deep\\a.rs': 2,
        'C:/repo/src/b.rs': 1,
        'C:/repository/other.rs': 1
    });
    assert.equal(result['c:/repo/src/deep'].code, 'M');
    assert.equal(result['c:/repo/src/deep'].diagnostic, 'warning');
    assert.equal(result['c:/repo/src'].diagnostic, 'error');
    assert.equal(result['c:/repo'].diagnostic, 'error');
    assert.equal(result['c:/repo/src/deep/a.rs'].code, 'M');
    assert.equal(fileDecorations('C:/repo', git)['c:/repo/src'].diagnostic, undefined);
    assert.deepEqual(fileDecorations('C:/repo', {}, {}), {});
    assert.equal(fileDecorations('C:/repo', {}, { 'C:/repository/a.rs': 1 })['c:/repo'], undefined);
});

test('diagnostic navigation publishes native details without floating windows and clears stale cards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-diagnostic-details-'));
    const cards: Extract<NidoEvent, { type: 'diagnostics' }>[] = [];
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, 'sample.txt'),
            'first line\nsecond line\nthird line\nfourth line\n'
        );
        session = await Session.create(root, (event) => {
            if (event.type === 'diagnostics') cards.push(event);
        });
        await session.openFile('sample.txt');
        await session.client.request('nvim_exec_lua', [
            `local ns = vim.api.nvim_create_namespace('native-details-test')
vim.g.details_test_ns = ns
vim.diagnostic.set(ns, 0, {
  {lnum=0, col=0, severity=2, source='rustc', code='unused_parens', message=[[Unnecessary parentheses
Remove these parentheses.]]},
  {lnum=1, col=1, severity=1, source='rustc', code='E0277', message='The trait bound is not satisfied'},
  {lnum=1, col=3, severity=2, source='lint', code=123, message='Another warning'},
  {lnum=3, col=0, severity=4, message='A hint'},
})`,
            []
        ]);
        const keys = async (sequence: string): Promise<void> => {
            await session!.input(sequence);
            await session!.client.request('nvim_eval', ['1']);
        };
        await keys('gl');
        assert.equal(cards.at(-1)?.focus, true);
        assert.equal(cards.at(-1)?.items[0]?.code, 'unused_parens');
        assert.equal(cards.at(-1)?.items[0]?.source, 'rustc');
        assert.equal(
            cards.at(-1)?.items[0]?.message,
            'Unnecessary parentheses\nRemove these parentheses.'
        );
        await keys(']d');
        assert.equal(cards.at(-1)?.focus, false);
        assert.deepEqual(
            cards.at(-1)?.items.map((item) => [item.line, item.column, item.severity, item.code]),
            [
                [2, 2, 1, 'E0277'],
                [2, 4, 2, '123']
            ]
        );
        assert.match(cards.at(-1)!.items[0].path, /sample\.txt$/);
        await keys('2]d');
        assert.equal(cards.at(-1)?.items[0]?.line, 4);
        await keys(']d');
        assert.equal(cards.at(-1)?.items[0]?.line, 1);
        await keys('[d');
        assert.equal(cards.at(-1)?.items[0]?.line, 4);
        assert.equal(((await session.client.request('nvim_list_wins', [])) as unknown[]).length, 1);
        await keys('k');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys(']d<Esc>');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys(']d<C-c>');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys('3G0');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys('gl');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys(']d');
        assert.ok(cards.at(-1)?.items.length);
        await keys('i');
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys('<Esc>gl');
        assert.ok(cards.at(-1)?.items.length);
        await session.client.request('nvim_exec_lua', [
            'vim.diagnostic.reset(vim.g.details_test_ns, 0)',
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.deepEqual(cards.at(-1)?.items, []);
        await keys('gl');
        assert.deepEqual(cards.at(-1)?.items, []);
        assert.equal(((await session.client.request('nvim_list_wins', [])) as unknown[]).length, 1);
        assert.equal(
            await readFile(join(root, 'sample.txt'), 'utf8'),
            'first line\nsecond line\nthird line\nfourth line\n'
        );
    } finally {
        await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('Neovim publishes and clears diagnostics including unopened files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-diagnostics-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const path = join(root, 'unopened.txt');
        await session.client.request('nvim_exec_lua', [
            "local path = ...; local b = vim.fn.bufadd(path); vim.fn.bufload(b); vim.diagnostic.set(vim.api.nvim_create_namespace('test'), b, {{lnum=0,col=0,severity=2,message='Warning'}, {lnum=0,col=0,severity=1,message='Error'}})",
            [path]
        ]);
        for (let i = 0; i < 50 && !Object.keys(session.state.diagnostics || {}).length; i++) {
            await new Promise((done) => setTimeout(done, 10));
        }
        const entries = Object.entries(session.state.diagnostics || {});
        assert.equal(gitFileKey(entries[0][0]), gitFileKey(path));
        assert.equal(entries[0][1], 1);
        assert.equal(session.state.problems?.length, 2);
        const decorations = fileDecorations(
            root,
            {},
            session.state.diagnostics,
            session.state.problems
        );
        assert.equal(decorations[gitFileKey(path)].errors, 1);
        assert.equal(decorations[gitFileKey(path)].warnings, 1);
        assert.equal(decorations[gitFileKey(root)].errors, 1);
        assert.equal(decorations[gitFileKey(root)].warnings, 1);
        const version = session.state.diagnosticsVersion!;
        await session.openProblem(1, version);
        assert.equal(await session.client.request('nvim_eval', ["expand('%:p')"]), path);
        await session.client.request('nvim_exec_lua', [
            "vim.diagnostic.reset(vim.api.nvim_create_namespace('test'))",
            []
        ]);
        for (let i = 0; i < 50 && Object.keys(session.state.diagnostics || {}).length; i++) {
            await new Promise((done) => setTimeout(done, 10));
        }
        assert.deepEqual(session.state.diagnostics, {});
        assert.deepEqual(session.state.problems, []);
        assert.deepEqual(
            fileDecorations(root, {}, session.state.diagnostics, session.state.problems),
            {}
        );
        await assert.rejects(session.openProblem(1, version), /Problems have changed/);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test(
    'terminal sessions run PowerShell, preserve their shell and stop with their workspace',
    { timeout: 30000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-terminal-'));
        let session: Session | undefined;
        try {
            session = await Session.create(root, () => {});
            const [terminal, same] = await Promise.all([
                session.openTerminal(),
                session.openTerminal()
            ]);
            assert.equal(terminal, same);
            assert.equal(terminal.workspace.kind, 'terminal');
            await terminal.input(
                "$nidoValue = 'kept'; Set-Content -Path first.txt -Value $nidoValue<CR>"
            );
            const waitFor = async (name: string): Promise<string> => {
                for (let i = 0; i < 100; i++) {
                    try {
                        return await readFile(join(root, name), 'utf8');
                    } catch {
                        await new Promise((done) => setTimeout(done, 100));
                    }
                }
                throw new Error(`Terminal did not create ${name}`);
            };
            assert.match(await waitFor('first.txt'), /kept/);
            await terminal.resize(100, 20);
            assert.equal(await session.openTerminal(), terminal);
            await terminal.input('Set-Content -Path second.txt -Value $nidoValue<CR>');
            assert.match(await waitFor('second.txt'), /kept/);
            assert.equal((await session.snapshot()).terminal, true);
            assert.equal((await terminal.snapshot()).kind, 'terminal');
            await assert.rejects(terminal.startTerminal('invalid'), /Invalid terminal shell/);
            await terminal.startTerminal('cmd.exe');
            await terminal.input('echo cmd-selected>cmd.txt<CR>');
            assert.match(await waitFor('cmd.txt'), /cmd-selected/);
            await session.stop();
            assert.notEqual(terminal.process.exitCode, null);
        } finally {
            await session?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }
);

test('word searches publish counts, distinguish current matches and clear on Escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-search-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'words.txt'), 'alpha beta alpha\nalpha\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.openFile('words.txt');
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.input('gg0*');
        await lua('return 1');
        assert.deepEqual(session.state.search, {
            pattern: '\\<alpha\\>',
            current: 2,
            total: 3,
            incomplete: 0
        });
        await lua('vim.cmd.redraw()');
        await lua('return 1');
        const row = grid.cells.find((cells) =>
            cells
                .map((cell) => cell.text)
                .join('')
                .includes('alpha beta alpha')
        )!;
        const text = row.map((cell) => cell.text).join('');
        assert.equal(
            grid.highlights.get(row[text.indexOf('alpha')].highlight)?.background,
            0x514020
        );
        assert.equal(
            grid.highlights.get(row[text.lastIndexOf('alpha')].highlight)?.background,
            0xa8cf9e
        );
        await session.input('#');
        await lua('return 1');
        assert.equal(session.state.search && session.state.search.current, 1);
        await session.input('<Esc>');
        await lua('return 1');
        assert.equal(session.state.search, false);
        await session.input('n');
        await lua('return 1');
        assert.equal(session.state.search && session.state.search.total, 3);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('explorer file actions preserve buffers, reject overwrites and protect workspace boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-file-actions-'));
    const outside = await mkdtemp(join(tmpdir(), 'nido-file-outside-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const action = (
            operation: import('../src/shared/types').FileAction,
            path: string,
            target = ''
        ): Promise<void> =>
            session!.fileAction(operation, path, target, (source) =>
                rename(source, join(root, 'trashed'))
            );
        await action('createDirectory', 'src');
        await action('createFile', 'src/first.txt');
        await writeFile(join(root, 'src/first.txt'), 'hello\n');
        await session.openFile('src/first.txt');
        const buffer = await session.client.request('nvim_get_current_buf', []);
        await action('rename', 'src', 'renamed');
        // Windows TEMP can use an 8.3 alias; Session resolves it to the canonical path.
        assert.equal(
            await session.client.request('nvim_buf_get_name', [buffer]),
            await realpath(join(root, 'renamed/first.txt'))
        );
        await action('copy', 'renamed', 'copied');
        assert.equal(await readFile(join(root, 'copied/first.txt'), 'utf8'), 'hello\n');
        await assert.rejects(
            action('rename', 'renamed/first.txt', 'copied/first.txt'),
            /already exists/
        );
        await assert.rejects(action('createFile', '../escape.txt'), /inside this workspace/);
        await assert.rejects(action('delete', ''), /inside this workspace/);
        await mkdir(join(root, '.git'));
        await assert.rejects(action('delete', '.git'), /outside .git/);
        await assert.rejects(action('copy', 'renamed', 'renamed/inside'), /inside itself/);
        await symlink(outside, join(root, 'link'), 'junction');
        await assert.rejects(action('createFile', 'link/escape.txt'), /outside this workspace/);
        await session.input('AX<Esc>');
        await session.client.request('nvim_eval', ['1']);
        await assert.rejects(action('delete', 'renamed'), /unsaved changes/);
        await assert.rejects(action('copy', 'renamed', 'dirty-copy'), /unsaved changes/);
        await session.save();
        await action('delete', 'renamed');
        assert.equal(await session.client.request('nvim_buf_is_valid', [buffer]), false);
        assert.equal(await readFile(join(root, 'trashed/first.txt'), 'utf8'), 'helloX\n');
    } finally {
        await session?.stop();
        await rm(join(root, 'link'), { force: true, recursive: true });
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test('file mutations serialize and retain edits arriving during OS operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-file-race-'));
    const session = await Session.create(root, () => {});
    try {
        await writeFile(join(root, 'source.txt'), 'saved\n');
        await session.openFile('source.txt');
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session.client.request('nvim_exec_lua', [code, []]);
        const buffer = await session.client.request('nvim_get_current_buf', []);
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const deletion = assert.rejects(
            session.fileAction('delete', 'source.txt', '', async (source) => {
                started();
                await gate;
                await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'keep these edits'})");
                await rename(source, join(root, 'trashed.txt'));
            }),
            /Failed to unload buffer/
        );
        await ready;
        // A second mutation must wait until the first operation releases its OS boundary.
        const creation = session.fileAction('createFile', 'source.txt', '', async () => {});
        release();
        await Promise.all([deletion, creation]);
        assert.equal(await session.client.request('nvim_buf_is_valid', [buffer]), true);
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'keep these edits');
        assert.equal(await readFile(join(root, 'trashed.txt'), 'utf8'), 'saved\n');
        assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), '');
        // Inject an edit between the disk rename and the buffer name update.
        await writeFile(join(root, 'rename-source.txt'), 'rename saved\n');
        await session.openFile('rename-source.txt');
        const request = session.client.request.bind(session.client);
        session.client.request = async (method, args = []) => {
            if (method === 'nvim_exec_lua' && String(args[0]).includes('local renamed = ...')) {
                await request('nvim_exec_lua', [
                    "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'edited during rename'})",
                    []
                ]);
            }
            return request(method, args);
        };
        await assert.rejects(
            session.fileAction('rename', 'rename-source.txt', 'moved.txt', async () => {}),
            /move was cancelled/
        );
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'edited during rename');
        assert.equal(await session.modified(), true);
        await session.save();
        assert.equal(
            await readFile(join(root, 'rename-source.txt'), 'utf8'),
            'edited during rename\n'
        );
        await assert.rejects(readFile(join(root, 'moved.txt')), /ENOENT/);
    } finally {
        await session.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('Ctrl Z undoes in normal, insert and visual modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-undo-key-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.input('ihello<Esc>');
        await lua('return 1');
        await session.input('dd');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
        await session.input('<C-z>');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
        await session.input('A world');
        await lua('return 1');
        await session.input('<C-z>');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
        assert.equal(await lua('return vim.fn.mode()'), 'i');
        await session.input('<Esc>dd');
        await lua('return 1');
        await session.input('V<C-z>');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'hello');
        assert.equal(await lua('return vim.fn.mode()'), 'n');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('completion navigation leaves text unchanged until Tab accepts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-completion-ranking-'));
    let session: Session | undefined;
    let candidates: string[] = [];
    try {
        session = await Session.create(root, (event) => {
            if (event.type !== 'redraw') return;
            for (const [name, ...calls] of event.events) {
                if (name === 'popupmenu_show')
                    candidates = (calls.at(-1)![0] as string[][]).map((item) => item[0]);
            }
        });
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.input('igetU');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU');
        await session.input(
            "<Cmd>lua vim.fn.complete(1, {'getOldUser', 'setUser', 'getUserName', 'getUser'})<CR>"
        );
        await lua('return 1');
        assert.equal(candidates.length, 4);
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU');
        for (const key of ['<Down>', '<Down>', '<Up>', '<C-n>', '<C-p>']) {
            await session.input(key);
            assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'getU', key);
        }
        await session.input('<Tab>');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), candidates[0]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('typing brackets inserts pairs, skips closing brackets and deletes empty pairs without changing paste', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-auto-brackets-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        const reset = async (): Promise<void> => {
            await session!.input('<Esc>');
            await lua(
                "vim.api.nvim_buf_set_lines(0, 0, -1, false, {''}); vim.api.nvim_win_set_cursor(0, {1, 0})"
            );
            await session!.input('i');
        };
        for (const [left, right] of [
            ['(', ')'],
            ['[', ']'],
            ['{', '}']
        ]) {
            await reset();
            await session.input(left);
            assert.deepEqual(
                await lua('return {vim.api.nvim_get_current_line(), vim.fn.col(".")}'),
                [left + right, 2]
            );
            await session.input(right);
            assert.equal(await lua('return vim.api.nvim_get_current_line()'), left + right);
            assert.equal(await lua('return vim.fn.col(".")'), 3);
            await reset();
            await session.input(left + '<BS>');
            assert.equal(await lua('return vim.api.nvim_get_current_line()'), '');
        }
        await reset();
        await session.input('([{value}])');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), '([{value}])');
        await reset();
        await session.paste('([{');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), '([{');
        await reset();
        await lua("vim.bo.syntax = 'typescript'");
        await session.input('// ');
        await lua('return vim.api.nvim_get_current_line()');
        await session.input('(');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), '// (');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('Enter inside braces opens an indented body and aligns the closing brace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-brace-enter-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        for (const [filetype, line, column, expandtab, expected] of [
            ['rust', 'fn main() {}', 11, true, ['fn main() {', '    ', '}']],
            ['typescript', '  if (true) {  }', 14, true, ['  if (true) {', '    ', '  }']],
            ['', '{}', 1, true, ['{', '  ', '}']],
            ['', '\t{}', 2, false, ['\t{', '\t\t', '\t}']]
        ] as const) {
            await session.input('<Esc>');
            await session.client.request('nvim_exec_lua', [
                `local ft, line, col, spaces = ...
vim.bo.filetype = ft
vim.bo.expandtab = spaces
vim.bo.shiftwidth = ft == 'rust' and 4 or 2
vim.bo.tabstop = 2
vim.api.nvim_buf_set_lines(0, 0, -1, false, {line})
vim.api.nvim_win_set_cursor(0, {1, col})`,
                [filetype, line, column, expandtab]
            ]);
            await session.input('i<CR>');
            assert.deepEqual(
                await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'),
                expected
            );
            assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [
                2,
                expected[1].length
            ]);
            await session.input('body');
            assert.equal(await lua('return vim.api.nvim_get_current_line()'), expected[1] + 'body');
        }
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('completion refreshes the same current-prefix list after typing and Backspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-completion-edits-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await lua(`vim.g.completion_prefixes = {}
vim.lsp.start({
  name = 'completion-fixture',
  cmd = function(dispatchers)
    local serial = 0
    local closed = false
    return {
      request = function(method, params, callback)
        serial = serial + 1
        local result
        if method == 'initialize' then
          result = {capabilities = {completionProvider = {}, textDocumentSync = 1}}
        elseif method == 'textDocument/completion' then
          local prefix = vim.api.nvim_get_current_line():sub(1, params.position.character)
          local prefixes = vim.g.completion_prefixes
          table.insert(prefixes, prefix)
          vim.g.completion_prefixes = prefixes
          local labels = prefix == 'println'
            and {'TOUCHPREDICTIONPARAMETERS_DEFAULT_RLS_LAMBDA_LEARNING_RATE', 'println'}
            or prefix == 'printl' and {'println', 'printLine'} or {'printLegacy'}
          result = {isIncomplete = false, items = {}}
          for _, label in ipairs(labels) do
            table.insert(result.items, {label = label, kind = 3})
          end
        end
        vim.defer_fn(function() callback(nil, result) end, 10)
        return true, serial
      end,
      notify = function() return true end,
      is_closing = function() return closed end,
      terminate = function() closed = true; dispatchers.on_exit(0, 0) end,
    }
  end,
})
assert(vim.wait(2000, function()
  local client = vim.lsp.get_clients({bufnr=0})[1]
  return client and client.initialized
end, 10))`);
        const labels = async (): Promise<string[]> =>
            (await lua(
                "return vim.tbl_map(function(item) return item.abbr end, vim.fn.complete_info({'items'}).items)"
            )) as string[];
        const waitFor = async (expected: string[]): Promise<void> => {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (JSON.stringify(await labels()) === JSON.stringify(expected)) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.deepEqual(
                await labels(),
                expected,
                JSON.stringify(
                    await lua(
                        'return {vim.g.completion_prefixes, vim.api.nvim_get_current_line(), vim.fn.mode()}'
                    )
                )
            );
        };
        await session.input('ip');
        await waitFor(['printLegacy']);
        for (const character of 'rintl') {
            await session.input(character);
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        await waitFor(['printLine', 'println']);
        const typed = await labels();
        await session.input('n');
        await waitFor(['println', 'TOUCHPREDICTIONPARAMETERS_DEFAULT_RLS_LAMBDA_LEARNING_RATE']);
        await session.input('<BS>');
        await waitFor(typed);
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'printl');
        const requests = await lua('return #vim.g.completion_prefixes');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(await labels(), typed);
        assert.equal(await lua('return #vim.g.completion_prefixes'), requests);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('bracket pairs share depth colors, ignore strings and comments, and refresh after edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-brackets-'));
    let session: Session | undefined;
    try {
        const content =
            'fn main() {\n  let x = ([1]);\n  let s = "([{}])"; // []\n  /* {\n  } */\n}\n';
        await writeFile(join(root, 'pairs.txt'), content);
        session = await Session.create(root, () => {});
        await session.openFile('pairs.txt');
        await session.client.request('nvim_exec_lua', ['vim.bo.syntax = "rust"', []]);
        const marks = async (): Promise<[number, number, number, { hl_group: string }][]> => {
            await session!.client.request('nvim_exec_lua', [
                'vim.wait(150); vim.cmd("redraw!")',
                []
            ]);
            return session!.client.request('nvim_exec_lua', [
                "return vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace('nido_brackets'), 0, -1, {details=true})",
                []
            ]) as Promise<[number, number, number, { hl_group: string }][]>;
        };
        const result = await marks();
        assert.equal(result.length, 8);
        const color = (row: number, column: number): string | undefined =>
            result.find((mark) => mark[1] === row && mark[2] === column)?.[3].hl_group;
        assert.equal(color(0, 7), color(0, 8));
        assert.equal(color(0, 10), color(5, 0));
        assert.equal(color(1, 10), color(1, 14));
        assert.equal(color(1, 11), color(1, 13));
        assert.notEqual(color(0, 10), color(1, 10));
        assert.notEqual(color(1, 10), color(1, 11));
        await session.client.request('nvim_exec_lua', [
            "vim.api.nvim_buf_set_lines(0, 0, -1, false, {'()'}); vim.api.nvim_exec_autocmds('TextChanged', {buffer=0})",
            []
        ]);
        assert.equal((await marks()).length, 2);
        assert.equal(await readFile(join(root, 'pairs.txt'), 'utf8'), content);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('bracket guides follow the innermost scope, ignore quoted brackets and clear on buffer switches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-bracket-guides-'));
    let session: Session | undefined;
    const grid = new Grid();
    try {
        await writeFile(
            join(root, 'scope.txt'),
            'function outer() {\n\tif (true) {\n\t\tconst s = "{ fake }"; // {\n\t\twork(\n\t\t\t"日",\n\t\t);\n\t}\n}\nconst empty = {};\n'
        );
        await writeFile(join(root, 'plain.txt'), 'plain text\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.openFile('scope.txt');
        await session.attach(100, 24);
        await lua(
            'vim.bo.syntax = "javascript"; vim.bo.tabstop = 4; vim.wait(200); vim.cmd("redraw!")'
        );
        await lua('return 1');
        assert.equal(grid.bracketGuides.length, 3);
        const before = await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)');
        await session.input('5G');
        await lua('vim.cmd("redraw!")');
        await lua('return 1');
        const active = grid.bracketGuides.filter((guide) => guide.active);
        assert.equal(active.length, 1);
        assert.deepEqual([active[0].top, active[0].bottom], [3, 5]);
        const offset = (await lua(
            'return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff'
        )) as number;
        assert.equal(active[0].column, offset + 8, 'tabs use display columns');
        assert.ok(active[0].opening > active[0].column);
        await session.input('3G');
        await lua('vim.cmd("redraw!")');
        await lua('return 1');
        assert.deepEqual(
            grid.bracketGuides
                .filter((guide) => guide.active)
                .map((guide) => [guide.top, guide.bottom]),
            [[1, 6]]
        );
        assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), before);
        await lua("vim.wo.foldmethod = 'manual'; vim.cmd('1,8fold'); vim.cmd('redraw!')");
        await lua('return 1');
        assert.equal(grid.bracketGuides.length, 0, 'folded scopes do not leave dangling guides');
        await session.input('zo');
        await lua('vim.cmd("redraw!")');
        await lua('return 1');
        assert.equal(grid.bracketGuides.length, 3);
        await session.openFile('plain.txt');
        await lua('vim.cmd("redraw!")');
        await lua('return 1');
        assert.equal(grid.bracketGuides.length, 0);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('EditorConfig reads CRLF files cleanly when the project requests LF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-editorconfig-eol-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, '.editorconfig'), 'root = true\n[*]\nend_of_line = lf\n');
        const original = 'first\r\nsecond\r\n';
        await writeFile(join(root, 'dos.txt'), original);
        session = await Session.create(root, () => {});
        const lua = (code: string): Promise<unknown> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.setEditorConfig(true);
        await session.openFile('dos.txt');
        assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
            'first',
            'second'
        ]);
        assert.equal(await lua('return vim.bo.fileformat'), 'unix');
        assert.equal(await lua("return require('nido_eol').detect()"), 'LF');
        assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), original);
        await lua('vim.cmd.edit({bang=true})');
        assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
            'first',
            'second'
        ]);
        await session.save();
        assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), 'first\nsecond\n');
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('EditorConfig toggles existing buffers, indentation guides and save rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-editorconfig-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        await writeFile(
            join(root, '.editorconfig'),
            'root = true\n[*]\nindent_style = space\nindent_size = 4\ntrim_trailing_whitespace = true\n[other.txt]\nindent_size = 8\n'
        );
        await writeFile(join(root, 'indent.txt'), 'root\n    child  \n        nested\n');
        await writeFile(join(root, 'other.txt'), '        other\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        await session.openFile('indent.txt');
        const lua = (code: string): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        const baseline = await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}');
        await session.setEditorConfig(true);
        await session.client.request('nvim_eval', ['1']);
        assert.deepEqual(
            await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}'),
            [4, 4, true]
        );
        assert.equal(grid.cells[1].filter((cell) => cell.text === '│').length, 1);
        assert.equal(grid.cells[2].filter((cell) => cell.text === '│').length, 2);
        assert.equal(await lua('return vim.bo.modified'), false);
        await session.save();
        assert.equal(
            await readFile(join(root, 'indent.txt'), 'utf8'),
            'root\n    child\n        nested\n'
        );
        await session.openFile('other.txt');
        assert.equal(await lua('return vim.bo.shiftwidth'), 8);
        await session.setEditorConfig(false);
        await session.openFile('indent.txt');
        assert.deepEqual(
            await lua('return {vim.bo.shiftwidth, vim.bo.tabstop, vim.bo.expandtab}'),
            baseline
        );
        await lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, {'    child  '})");
        await session.save();
        assert.match(await readFile(join(root, 'indent.txt'), 'utf8'), /child {2}\n/);
        await session.setEditorConfig(true);
        await session.setEditorConfig(true);
        assert.equal(
            await lua(
                "return #vim.api.nvim_get_autocmds({group='nvim.editorconfig', event='BufWritePre', buffer=0})"
            ),
            1
        );
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('Git gutter signs track HEAD, unsaved edits, deletions, new files and commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-git-signs-'));
    let session: Session | undefined;
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root });
    };
    try {
        git('init', '-q');
        await writeFile(join(root, 'tracked.txt'), 'first\r\nsecond\r\nthird\r\n');
        await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
        git('add', '.');
        git(
            '-c',
            'user.name=Nido Test',
            '-c',
            'user.email=nido@example.test',
            'commit',
            '-qm',
            'base'
        );
        const grid = new Grid();
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid.apply(event.events);
        });
        const lua = (
            code: string,
            args: unknown[] = []
        ): ReturnType<Session['client']['request']> =>
            session!.client.request('nvim_exec_lua', [code, args]);
        const signs = async (expected: [number, string][], refresh = true): Promise<void> => {
            await lua(
                `
local expected, refresh = ...
local buffer = vim.api.nvim_get_current_buf()
local namespace = vim.api.nvim_get_namespaces().nido_git_signs
local function signs()
  local result = {}
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, namespace, 0, -1, {details=true})) do
    table.insert(result, {mark[2], mark[4].sign_hl_group})
  end
  return result
end
if refresh then require('nido_git_signs').refresh(buffer) end
assert(vim.wait(5000, function() return vim.deep_equal(signs(), expected) end, 20), vim.inspect(signs()))
vim.cmd('redraw!')`,
                [expected, refresh]
            );
        };
        const edit = (lines: string[]): ReturnType<Session['client']['request']> =>
            lua('vim.api.nvim_buf_set_lines(0, 0, -1, false, ...)', [lines]);
        await session.openFile('tracked.txt');
        await signs([]);
        await edit(['first', 'changed', 'third', 'added']);
        await signs([
            [1, 'NidoGitChanged'],
            [3, 'NidoGitAdded']
        ]);
        await lua('return 1');
        const ink = (row: number): (number | undefined)[] =>
            grid.cells[row]
                .filter((cell) => cell.text === '▎' || cell.text === '▸')
                .map((cell) => grid.highlights.get(cell.highlight)?.foreground);
        assert.deepEqual(ink(1), [0x0078d4]);
        assert.deepEqual(ink(3), [0x2ea043]);
        const marks = (): ReturnType<Session['client']['request']> =>
            lua(`return vim.api.nvim_buf_get_extmarks(0,
            vim.api.nvim_get_namespaces().nido_git_signs, 0, -1, {details=true})`);
        const beforeSave = await marks();
        await session.save();
        await lua('vim.wait(500)');
        assert.deepEqual(await marks(), beforeSave, 'saving unchanged signs preserves their IDs');
        await edit(['second', 'third']);
        await signs([[0, 'NidoGitDeleted']]);
        await lua('return 1');
        assert.deepEqual(ink(0), [0xf85149]);
        await edit(['first', 'second']);
        await signs([[1, 'NidoGitDeleted']]);
        await edit(['first', 'third']);
        await signs([[1, 'NidoGitDeleted']]);
        await edit(['changed']);
        await signs([
            [0, 'NidoGitChanged'],
            [0, 'NidoGitDeleted']
        ]);
        await edit([]);
        await signs([[0, 'NidoGitDeleted']]);
        await edit(['first', 'second', 'third']);
        await signs([]);
        await edit(['first', 'changed', 'third']);
        await session.save();
        git('add', 'tracked.txt');
        await signs([[1, 'NidoGitChanged']]);
        git(
            '-c',
            'user.name=Nido Test',
            '-c',
            'user.email=nido@example.test',
            'commit',
            '-qm',
            'update'
        );
        await signs([], false);
        await writeFile(join(root, 'new.txt'), 'new\nfile\n');
        await session.openFile('new.txt');
        await signs([
            [0, 'NidoGitAdded'],
            [1, 'NidoGitAdded']
        ]);
        await writeFile(join(root, 'ignored.txt'), 'ignored\n');
        await session.openFile('ignored.txt');
        await signs([]);
        await mkdir(join(root, 'fresh'));
        execFileSync('git', ['init', '-q'], { cwd: join(root, 'fresh') });
        await writeFile(join(root, 'fresh/new.txt'), 'unborn\n');
        await session.openFile('fresh/new.txt');
        await signs([[0, 'NidoGitAdded']]);
        assert.equal(await session.modified(), false);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('CodeLens keeps unchanged and edit-shifted marks and updates only changed labels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-stable-lenses-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.client.request('nvim_exec_lua', [
            `
local api = vim.api
api.nvim_buf_set_lines(0, 0, -1, false, {'fn main() {}', '', '#[test] fn sample() {}'})
vim.bo.filetype = 'rust'
local module = require('nido_runnables')
local namespace = api.nvim_get_namespaces().nido_runnables
local items = {}
local function item(row, command)
  return {kind='cargo', args={cargoArgs={command}}, location={
    targetSelectionRange={start={line=row}}, targetRange={start={line=row}, ['end']={line=row}},
  }}
end
local original = vim.lsp.get_clients
vim.lsp.get_clients = function(options)
  if options and options.name == 'rust_analyzer' then
    return {{request=function(_, _, _, callback) callback(nil, items) end}}
  end
  return original(options)
end
local ok, err = pcall(function()
  local function marks() return api.nvim_buf_get_extmarks(0, namespace, 0, -1, {details=true}) end
  items = {item(0, 'run'), item(2, 'test')}
  module.refresh(0)
  local before = marks()
  assert(#before == 2)
  module.refresh(0)
  assert(vim.deep_equal(marks(), before), 'identical results must preserve extmark IDs')
  api.nvim_buf_set_lines(0, 0, 0, false, {'// inserted'})
  items = {item(1, 'run'), item(3, 'test')}
  local shifted = marks()
  module.refresh(0)
  assert(vim.deep_equal(marks(), shifted), 'reuse marks that moved with editing')
  items = {item(1, 'test')}
  module.refresh(0)
  assert(#marks() == 2, 'keep layout while removal is being confirmed')
  assert(vim.wait(1000, function() return #marks() == 1 end, 10), 'confirm removed lens')
  local changed = marks()
  assert(#changed == 1 and changed[1][2] == 1)
  assert(changed[1][4].virt_lines[1][1][1] == '  ▶ Run Tests')
  assert(changed[1][1] ~= before[1][1], 'changed label must be replaced')
end)
vim.lsp.get_clients = original
assert(ok, err)
`,
            []
        ]);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('indent guides follow depth, tabs and blank lines without changing text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-indent-'));
    const grid = new Grid();
    let session: Session | undefined;
    try {
        const content = 'root\n  child\n    nested\n\n    sibling\n\tchild\nroot\n';
        await writeFile(join(root, 'indent.txt'), content);
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') {
                grid.apply(event.events);
            }
        });
        await session.openFile('indent.txt');
        await session.client.request('nvim_exec_lua', [
            'vim.bo.shiftwidth = 2; vim.bo.tabstop = 2; vim.cmd("redraw!")',
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        const guides = (row: number): Grid['cells'][number] =>
            grid.cells[row].filter((cell) => cell.text === '│');
        assert.equal(guides(0).length, 0);
        assert.equal(guides(1).length, 1);
        assert.equal(guides(2).length, 2);
        assert.equal(guides(3).length, 2);
        assert.equal(guides(5).length, 1);
        const colors = guides(2).map((cell) => grid.highlights.get(cell.highlight)?.foreground);
        assert.deepEqual(colors, [0x75633f, 0x476a86]);
        await session.client.request('nvim_exec_lua', [
            'vim.wo.wrap = false; vim.api.nvim_win_set_cursor(0, {3, 4}); vim.fn.winrestview({leftcol=2}); vim.cmd("redraw!")',
            []
        ]);
        await session.client.request('nvim_eval', ['1']);
        assert.equal(guides(2).length, 1);
        assert.equal(grid.highlights.get(guides(2)[0].highlight)?.foreground, 0x476a86);
        assert.equal(await session.modified(), false);
        assert.equal(await readFile(join(root, 'indent.txt'), 'utf8'), content);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('scroll follows pixel distance and preserves insert mode and file contents', async () => {
    assert.equal(scrollOffset(100, 0), 100);
    assert.equal(scrollOffset(100, 60), 12.5);
    assert.equal(scrollOffset(-100, 60), -12.5);
    assert.equal(scrollOffset(100, 120), 0);
    assert.equal(scrollOffset(100, 500), 0);
    let remainder = 0,
        lines = 0;
    for (let i = 0; i < 25; i++) {
        const result = accumulateScroll(remainder, 1, 0, 25, 500);
        remainder = result.remainder;
        lines += result.lines;
    }
    assert.equal(lines, 1);
    assert.deepEqual(accumulateScroll(0, 3, 1, 25, 500), { lines: 3, remainder: 0 });
    assert.equal(accumulateScroll(0, 1, 2, 25, 500).lines, 20);
    assert.equal(accumulateScroll(20, -25, 0, 25, 500).lines, -1);
    assert.equal(accumulateScroll(0, 0, 0, 25, 500).lines, 0);
    const root = await mkdtemp(join(tmpdir(), 'nido-scroll-'));
    let session: Session | undefined;
    try {
        const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        await writeFile(join(root, 'scroll.txt'), content);
        session = await Session.create(root, () => {});
        await session.openFile('scroll.txt');
        await session.scroll(1);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 2);
        await session.input('i');
        await session.client.request('nvim_eval', ['1']);
        await session.scroll(2);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 4);
        assert.equal(await session.client.request('nvim_eval', ['mode()']), 'i');
        assert.equal(await session.modified(), false);
        await session.scroll(-1);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
        const offsets: number[] = [];
        session.client.on('notification', (method: string, args: unknown[]) => {
            if (method === 'nido:pixel_scroll') offsets.push(Number(args[0]));
        });
        await session.scroll(0.2, true, true);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
        assert.ok(Math.abs(offsets.at(-1)! - 0.2) < 0.001);
        await session.scroll(0.9, true, true);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 4);
        assert.ok(Math.abs(offsets.at(-1)! - 0.1) < 0.001);
        await session.scroll(-0.2, true, true);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 3);
        assert.ok(Math.abs(offsets.at(-1)! - 0.9) < 0.001);
        await session.scroll(-100.3, true, true);
        assert.equal(await session.client.request('nvim_eval', ["line('w0')"]), 1);
        assert.equal(offsets.at(-1), 0);
        await session.scroll(1000, true, true);
        assert.equal(offsets.at(-1), 0);
        await session.scroll(0.2, true, true);
        assert.equal(offsets.at(-1), 0);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('line endings normalize only in memory until saved, preserve content and support undo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-eol-'));
    let session: Session | undefined;
    try {
        const original = 'one\r\ntwo\ninside\rcarriage\r\nlast';
        await writeFile(join(root, 'mixed.txt'), original);
        await writeFile(join(root, 'dos.txt'), 'one\r\ntwo\r\n');
        const notices: string[] = [];
        session = await Session.create(root, (event) => {
            if (event.type === 'error') notices.push(event.message);
        });
        const lua = (code: string): Promise<unknown> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        await session.openFile('mixed.txt');
        await lua('return 1');
        assert.equal(session.state.lineEnding, 'Mixed');
        assert.ok(notices.some((message) => message.includes('Mixed line endings')));
        await session.client.request('nvim_win_set_cursor', [0, [2, 1]]);
        await session.setLineEnding('LF');
        await lua('return 1');
        assert.equal(session.state.lineEnding, 'LF');
        assert.equal(await session.bufferModified(session.state.current), true);
        assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(0)'), [2, 1]);
        assert.equal(await readFile(join(root, 'mixed.txt'), 'utf8'), original);
        await lua('vim.cmd.undo()');
        assert.equal(await lua("return require('nido_eol').detect()"), 'Mixed');
        await session.setLineEnding('LF');
        await session.save();
        assert.equal(
            await readFile(join(root, 'mixed.txt'), 'utf8'),
            'one\ntwo\ninside\rcarriage\nlast'
        );
        await session.setLineEnding('CRLF');
        await session.save();
        assert.equal(
            await readFile(join(root, 'mixed.txt'), 'utf8'),
            'one\r\ntwo\r\ninside\rcarriage\r\nlast'
        );
        await session.openFile('dos.txt');
        await lua('return 1');
        assert.equal(session.state.lineEnding, 'CRLF');
        await session.setLineEnding('LF');
        assert.equal(await session.bufferModified(session.state.current), true);
        await session.save();
        assert.equal(await readFile(join(root, 'dos.txt'), 'utf8'), 'one\ntwo\n');
        await assert.rejects(session.setLineEnding('invalid' as 'LF'));
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('GUI file opens and workspace restoration do not inherit binary mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-text-mode-'));
    let session: Session | undefined;
    try {
        const samples = [
            { name: 'dos.txt', text: 'first\r\ninside\rcarriage\r\nlast\r\n', format: 'dos' },
            { name: 'unix.txt', text: 'first\ninside\rcarriage\nlast\n', format: 'unix' }
        ];
        for (const sample of samples) await writeFile(join(root, sample.name), sample.text);
        session = await Session.create(root, () => {});
        const lua = (code: string): Promise<unknown> =>
            session!.client.request('nvim_exec_lua', [code, []]);
        for (const sample of samples) {
            await lua('vim.o.binary = true');
            await session.openFile(sample.name);
            assert.equal(await lua('return vim.bo.binary'), false);
            assert.equal(await lua('return vim.bo.fileformat'), sample.format);
            assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'), [
                'first',
                'inside\rcarriage',
                'last'
            ]);
            assert.equal(await lua('return vim.bo.modified'), false);
            await session.save();
            assert.equal(await readFile(join(root, sample.name), 'utf8'), sample.text);
        }
        await lua("vim.cmd('bwipeout! dos.txt'); vim.o.binary = true");
        const path = join(root, 'dos.txt');
        assert.deepEqual(
            await session.restore({
                root,
                files: [{ path, line: 2, column: 1 }],
                current: path
            }),
            []
        );
        assert.equal(await lua('return vim.bo.binary'), false);
        assert.equal(await lua('return vim.bo.fileformat'), 'dos');
        assert.equal(await lua('return vim.api.nvim_get_current_line()'), 'inside\rcarriage');
        assert.equal(await readFile(path, 'utf8'), samples[0].text);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('resize waits for UI reattachment instead of using a detached channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-ui-reattach-'));
    let session: Session | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        session = await Session.create(root, () => {});
        await session.attach(80, 25);
        const request = session.client.request.bind(session.client);
        let detached!: () => void;
        const detaching = new Promise<void>((resolve) => {
            detached = resolve;
        });
        session.client.request = async (method, args = []) => {
            const result = await request(method, args);
            if (method === 'nvim_ui_detach') {
                detached();
                await gate;
            }
            return result;
        };
        const attaching = session.attach(90, 26);
        await detaching;
        const resizing = session.resize(72, 22);
        setTimeout(release, 30);
        const results = await Promise.allSettled([attaching, resizing]);
        assert.ok(
            results.every((result) => result.status === 'fulfilled'),
            JSON.stringify(results)
        );
        const uis = (await request('nvim_list_uis', [])) as { width: number; height: number }[];
        assert.deepEqual([uis[0].width, uis[0].height], [72, 22]);
    } finally {
        release();
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('a renderer joining after Neovim startup receives syntax colors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-colors-'));
    let grid: Grid | undefined;
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'main.rs'), 'fn main() { let greeting = "hello"; }\n');
        session = await Session.create(root, (event) => {
            if (event.type === 'redraw') grid?.apply(event.events);
        });
        await session.openFile('main.rs');
        // The React renderer does not exist while Session.create initializes Neovim.
        grid = new Grid();
        await session.attach(90, 25);
        await session.client.request('nvim_eval', ['1']);
        const row = grid.cells.find((cells) =>
            cells
                .map((cell) => cell.text)
                .join('')
                .includes('fn main')
        );
        assert.ok(row);
        const start = row
            .map((cell) => cell.text)
            .join('')
            .indexOf('fn main');
        assert.equal(grid.highlights.get(row[start].highlight)?.foreground, 0x569cd6);
        const string = row
            .map((cell) => cell.text)
            .join('')
            .indexOf('hello');
        assert.equal(grid.highlights.get(row[string].highlight)?.foreground, 0xce9178);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('Nido uses bundled Neovim and isolated config', async () => {
    const session = await Session.create(process.cwd(), () => {});
    try {
        await session.attach(80, 24);
        const result = await session.client.request('nvim_exec_lua', [
            `assert(vim.wait(5000, function() return vim.v.vim_did_enter == 1 end))
      assert(vim.env.NVIM_APPNAME == 'nido')
      local found = false
      for _, script in ipairs(vim.fn.getscriptinfo()) do
        if script.name:match('nido[/\\\\]init.lua$') then found = true end
      end
      assert(found, 'Nido init.lua must be sourced')
      assert(vim.v.progpath:match('nvim%-win64[/\\\\]bin[/\\\\]nvim.exe$'))
      assert(package.loaded.lazy == nil and package.loaded.noice == nil)
      local paths = vim.opt.runtimepath:get()
      assert(#paths == 3)
      assert(vim.g.colors_name == 'azami')
      assert(vim.api.nvim_get_hl(0, {name='Normal'}).bg == 0x121212)
      assert(paths[1] == vim.env.VIMRUNTIME)
      assert(paths[2] == vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim')
      for _, language in ipairs({'markdown', 'markdown_inline', 'c', 'lua', 'query', 'vim', 'vimdoc'}) do
        assert(vim.treesitter.language.add(language), language .. ' parser must load')
      end
      local fence = string.rep(string.char(96), 3)
      local buf, win = vim.lsp.util.open_floating_preview({'# Documentation', '', '**hello**', '', fence .. 'rust', 'fn example() {}', fence}, 'markdown', {})
      assert(vim.treesitter.get_parser(buf):parse()[1])
      vim.api.nvim_win_close(win, true)
      return {vim.g.nido, vim.o.showtabline, vim.o.laststatus, vim.o.showmode}`,
            []
        ]);
        assert.deepEqual(result, [true, 0, 0, false]);
    } finally {
        await session.stop();
    }
});

test('workspace snapshot restores each cursor and tolerates missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-restore-'));
    const sessions: Session[] = [];
    try {
        await writeFile(join(root, 'first.txt'), 'first line\nsecond line\nthird line\n');
        await writeFile(join(root, 'second.txt'), 'another file\n');
        const first = await Session.create(root, () => {});
        sessions.push(first);
        await first.openFile('first.txt');
        await first.client.request('nvim_win_set_cursor', [0, [3, 4]]);
        await first.openFile('second.txt');
        await first.client.request('nvim_win_set_cursor', [0, [1, 6]]);
        const snapshot = await first.snapshot();
        assert.deepEqual(
            snapshot.files.map((f) => [f.line, f.column]),
            [
                [3, 4],
                [1, 6]
            ]
        );
        const path = join(root, 'workspaces.json');
        assert.deepEqual((await readLayout(path)).workspaces, []);
        await writeLayout(path, { version: 1, workspaces: [snapshot], active: 0 });
        await first.stop();
        const restored = await Session.create(root, () => {});
        sessions.push(restored);
        assert.deepEqual(await restored.restore((await readLayout(path)).workspaces[0]), []);
        await restored.attach(90, 30);
        assert.deepEqual(await restored.snapshot(), snapshot);
        await restored.stop();
        await writeFile(join(root, 'first.txt'), 'short\n');
        await rm(join(root, 'second.txt'));
        const changed = await Session.create(root, () => {});
        sessions.push(changed);
        assert.equal((await changed.restore(snapshot)).length, 1);
        assert.equal((await changed.snapshot()).files[0].line, 1);
        await writeFile(path, '{broken');
        await assert.rejects(readLayout(path));
        await writeFile(path, JSON.stringify({ version: 1, active: 0, workspaces: [{ root }] }));
        await assert.rejects(readLayout(path), /Invalid/);
    } finally {
        await Promise.all(sessions.map((s) => s.stop()));
        await rm(root, { recursive: true, force: true });
    }
});

test('CodeLens rows compact while clicks, fractional scrolling and the command line stay aligned', () => {
    const grid = new Grid();
    grid.busy = true;
    grid.pixelScrollEnabled = true;
    grid.apply([
        ['grid_resize', [1, 3, 12]],
        ['hl_attr_define', [1, {}, {}, [{ hi_name: 'NidoCodeLens' }]]],
        ['hl_attr_define', [2, {}, {}, [{ hi_name: 'NidoCodeLensHint' }]]],
        [
            'grid_line',
            [
                1,
                0,
                0,
                [
                    ['R', 1],
                    [' ', 0, 2]
                ]
            ]
        ],
        ['grid_line', [1, 1, 0, [['a', 0]]]],
        [
            'grid_line',
            [
                1,
                2,
                0,
                [
                    ['D', 1],
                    ['h', 2]
                ]
            ]
        ],
        [
            'grid_line',
            [
                1,
                3,
                0,
                [
                    ['R', 1],
                    ['x', 0]
                ]
            ]
        ],
        ['grid_line', [1, 4, 0, [[' ', 1, 3]]]],
        ['grid_line', [1, 5, 0, [['R', 1]]]],
        ['grid_line', [1, 6, 0, [['b', 0]]]],
        ['grid_line', [1, 7, 0, [['h', 2]]]],
        ['grid_line', [1, 9, 0, [['c', 0]]]],
        ['grid_line', [1, 11, 0, [[':', 0]]]]
    ]);
    const context = {
        measureText: () => ({ width: 8 }),
        ...Object.fromEntries(
            [
                'setTransform',
                'fillRect',
                'save',
                'restore',
                'translate',
                'beginPath',
                'rect',
                'clip',
                'drawImage',
                'fillText'
            ].map((name) => [name, () => {}])
        )
    } as unknown as CanvasRenderingContext2D;
    let glyphs = 0;
    context.fillText = () => {
        glyphs++;
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
        ownerDocument: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) }
    } as unknown as HTMLCanvasElement;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        value: { devicePixelRatio: 2 },
        configurable: true
    });
    try {
        grid.draw(canvas, 160, 264, 14, 'monospace', false);
        assert.equal(grid.cellHeight, 24);
        assert.deepEqual(
            Array.from({ length: grid.rows }, (_, row) => grid.rowTop(row)),
            [0, 17, 41, 58, 82, 106, 123, 147, 164, 188, 212, 236]
        );
        assert.equal(grid.rowTop(0.5), 8.5);
        assert.equal(grid.rowTop(1.5), 29);
        assert.equal(grid.extraRows, 1);
        for (let row = 0; row < grid.rows - 1; row++) {
            const top = grid.rowY(row);
            assert.equal(grid.rowAt(top), row);
            assert.equal(grid.rowAt(top + (grid.rowTop(row + 1) - grid.rowTop(row)) / 2), row);
        }
        assert.equal(grid.rowY(grid.rows - 1), 240);
        assert.equal(grid.rowAt(238), -1);
        assert.equal(grid.rowAt(240), -1);
        grid.scrolling = true;
        grid.scrollFraction = 0.3;
        const originalGlyphs = glyphs;
        grid.draw(canvas, 160, 264, 14, 'monospace', false);
        assert.equal(glyphs, originalGlyphs, 'fractional scrolling reuses the row images');
        assert.equal(grid.rowY(1), 11.9);
        assert.equal(grid.rowAt(grid.rowY(1) + 12), 1);
        assert.equal(grid.rowY(grid.rows - 1), 240);
        grid.scrolling = false;
        grid.draw(canvas, 160, 264, 14, 'monospace', false);
        assert.equal(grid.rowY(1), 12, 'settled scrolling snaps to a physical pixel');
        assert.equal(grid.rowAt(11.99), 0);
        assert.equal(grid.rowAt(12), 1);
        assert.equal(grid.rowY(grid.rows - 1), 240);
        assert.equal(glyphs, originalGlyphs, 'settling reuses the native row images');
        grid.apply([['grid_line', [1, 0, 0, [['x', 0]]]], ['flush']]);
        grid.scrollFraction = 0;
        grid.draw(canvas, 160, 264, 14, 'monospace', false);
        assert.ok(glyphs > originalGlyphs, 'edited rows invalidate the cached text');
        assert.equal(grid.rowTop(1), 24);
        assert.equal(grid.extraRows, 0);
        assert.equal(grid.rowY(grid.rows - 1), 240);
    } finally {
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
    }
});

test('grid updates preserve highlights, wide characters and scroll regions', () => {
    const grid = new Grid();
    grid.apply([
        ['grid_resize', [1, 5, 3]],
        [
            'grid_line',
            [
                1,
                0,
                0,
                [
                    ['日', 2],
                    ['', 2],
                    ['x', 3, 3]
                ]
            ]
        ],
        ['grid_line', [1, 1, 0, [['b', 4, 5]]]],
        ['grid_line', [1, 2, 0, [['c', 5, 5]]]],
        ['grid_scroll', [1, 0, 3, 0, 5, 1, 0]]
    ]);
    assert.deepEqual(grid.cells[0][0], { text: 'b', highlight: 4 });
    assert.equal(grid.cells[1][4].text, 'c');
    assert.equal(grid.cells[2][0].text, ' ');
    grid.apply([['grid_scroll', [1, 0, 3, 0, 5, -1, 0]]]);
    assert.equal(grid.cells[1][0].text, 'b');
    assert.equal(grid.apply([['flush']]), true);
    assert.equal(
        vimKey({
            key: '<',
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
            metaKey: false,
            isComposing: false
        }),
        '<LT>'
    );
    assert.equal(
        vimKey({
            key: 'Tab',
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
            metaKey: false,
            isComposing: false
        }),
        '<S-Tab>'
    );
    assert.equal(
        vimKey({
            key: 'F12',
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
            metaKey: false,
            isComposing: false
        }),
        '<S-F12>'
    );
    assert.equal(
        vimKey({
            key: 'Enter',
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false,
            isComposing: true
        }),
        null
    );
});

test('pasting preserves the order of preceding and following keyboard input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-paste-order-'));
    let session: Session | undefined;
    try {
        await writeFile(join(root, 'file.txt'), 'ab\n');
        session = await Session.create(root, () => {});
        await session.openFile('file.txt');
        await Promise.all([session.input('i'), session.paste('X'), session.input('Y<Esc>')]);
        const lines = await session.client.request('nvim_buf_get_lines', [0, 0, -1, false]);
        assert.deepEqual(lines, ['XYab']);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test('save and save all wait for pending committed input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-save-input-order-'));
    try {
        for (const command of ['save', 'saveAll'] as const) {
            const file = join(root, 'file.txt');
            await writeFile(file, 'original\n');
            const session = await Session.create(root, () => {});
            let release!: () => void;
            let started!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const inputStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            try {
                await session.openFile('file.txt');
                const request = session.client.request.bind(session.client);
                session.client.request = async (name, args = []) => {
                    if (name === 'nvim_input' && args[0] === 'i') {
                        started();
                        await gate;
                    }
                    return request(name, args);
                };
                const opening = session.input('i');
                await inputStarted;
                const text = session.input('日本語入力<Esc>');
                const saving = session[command]();
                // Let an incorrectly unqueued write reach Neovim before releasing input.
                await new Promise<void>((resolve) => setImmediate(resolve));
                await request('nvim_eval', ['1']);
                release();
                await Promise.all([opening, text, saving]);
                assert.equal(await readFile(file, 'utf8'), '日本語入力original\n', command);
            } finally {
                release();
                await session.stop();
            }
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test(
    'saving while a Vim command waits for a key keeps subsequent input available',
    { timeout: 10000 },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'nido-save-pending-command-'));
        let session: Session | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await writeFile(join(root, 'file.txt'), 'original\n');
            session = await Session.create(root, () => {});
            await session.openFile('file.txt');
            await session.input('0r');
            assert.equal(await session.inputMode(), 'R');
            await Promise.race([
                Promise.all([session.save(), session.input('X<Esc>')]),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Saving blocked subsequent input.')),
                        2000
                    );
                })
            ]);
            assert.equal(await session.client.request('nvim_get_current_line', []), 'Xriginal');
        } finally {
            clearTimeout(timer);
            await session?.client.request('nvim_input', ['<Esc>']).catch(() => {});
            await session?.stop();
            await rm(root, { recursive: true, force: true });
        }
    }
);

test('two real Neovim sessions edit, save, switch buffers and isolate state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-test-'));
    const sessions: Session[] = [];
    try {
        await mkdir(join(root, 'one'));
        await mkdir(join(root, 'two'));
        await writeFile(join(root, 'one', 'first.ts'), 'const original = 1;\n');
        await writeFile(join(root, 'one', 'second.ts'), 'const second = 2;\n');
        await writeFile(join(root, 'outside.txt'), 'outside');
        const grids = [new Grid(), new Grid()];
        for (const [i, name] of ['one', 'two'].entries()) {
            const session = await Session.create(join(root, name), (event) => {
                if (event.type === 'redraw') grids[i].apply(event.events);
            });
            sessions.push(session);
            await session.attach(80, 24);
        }
        const [first, second] = sessions;
        assert.notEqual(first.process.pid, second.process.pid);
        await first.openFile('first.ts');
        await first.input('gg0i// 日本語<CR><Esc>');
        await first.client.request('nvim_eval', ['1']);
        assert.equal(await first.modified(), true);
        assert.equal(await second.modified(), false);
        await assert.rejects(() => second.save(), /file name|filename/i);
        await first.save();
        assert.match(await readFile(join(root, 'one', 'first.ts'), 'utf8'), /日本語/);
        await first.openFile('second.ts');
        const current = (await first.client.request('nvim_exec_lua', [
            'return vim.api.nvim_get_current_buf()',
            []
        ])) as number;
        await first.input('A // changed<Esc>');
        await first.client.request('nvim_eval', ['1']);
        await assert.rejects(() => first.closeBuffer(current), /modified|changes/i);
        await first.saveAll();
        await first.closeBuffer(current);
        assert.equal(await first.modified(), false);
        await assert.rejects(() => first.path('../outside.txt'), /outside/);
        assert.deepEqual((await first.files('')).map((f) => f.name).sort(), [
            'first.ts',
            'second.ts'
        ]);
        assert.deepEqual((await first.findFiles()).map((f) => f.name).sort(), [
            'first.ts',
            'second.ts'
        ]);
        assert.ok(grids[0].cells.length);
        assert.ok(grids[0].cells.some((r) => r.some((c) => c.text !== ' ')));
        await first.resize(90, 30);
    } finally {
        await Promise.all(sessions.map((session) => session.stop()));
        await rm(root, { recursive: true, force: true });
    }
});

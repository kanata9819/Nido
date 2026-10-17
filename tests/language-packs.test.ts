import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    LanguagePacks,
    discoverLanguagePacks,
    validateLanguagePack
} from '../src/main/languagePacks';
import { Session } from '../src/main/session';
import type { LanguagePackManifest } from '../src/shared/languagePacks';

const resources = resolve('resources');
const manifest: LanguagePackManifest = {
    schemaVersion: 1,
    id: 'python-test',
    version: '1.0.0',
    title: 'Python test',
    description: 'Integration fixture',
    filetypes: ['python'],
    serverName: 'python_pack_test',
    command: [process.execPath, resolve('tests/fixtures/language-pack-server.mjs')],
    rootMarkers: ['pyproject.toml'],
    settings: { python: { analysis: true } },
    initOptions: { test: true }
};
const cleanup = (root: string): Promise<void> =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test('packs validate before installation, isolate broken files and persist concurrent choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nido-packs-'));
    try {
        const manager = new LanguagePacks(resources, root);
        const initial = await manager.load();
        assert.deepEqual(initial.errors, []);
        assert.deepEqual(initial.packs.map((pack) => pack.id).sort(), [
            'deno',
            'rust',
            'typescript'
        ]);
        const source = join(root, 'python.json');
        await writeFile(source, JSON.stringify(manifest));
        await manager.install(source);
        await assert.rejects(manager.install(source), /already installed/);
        await writeFile(join(manager.directory, 'broken.json'), '{');
        await writeFile(
            join(manager.directory, 'duplicate.json'),
            JSON.stringify({ ...manifest, id: 'typescript', serverName: 'other' })
        );
        const config = await manager.load();
        assert.equal(config.packs.length, 4);
        assert.equal(config.errors.length, 2);
        assert.equal(config.packs.find((pack) => pack.id === manifest.id)?.bundled, false);
        await Promise.all([
            manager.setEnabled('rust', false),
            manager.setEnabled('typescript', false),
            manager.setEnabled(manifest.id, false)
        ]);
        const restored = await new LanguagePacks(resources, root).load();
        assert.deepEqual(restored.disabled.sort(), ['python-test', 'rust', 'typescript']);
        await manager.setEnabled('rust', true);
        assert.deepEqual((await manager.load()).disabled.sort(), ['python-test', 'typescript']);
        await assert.rejects(manager.setEnabled('unknown', false), /Unknown/);
        for (const change of [
            { id: '../escape' },
            { schemaVersion: 2 },
            { command: 'tool --stdio' },
            { adapter: 'typescript' },
            { filetypes: ['../python'] },
            { rootMarkers: ['../outside'] }
        ]) {
            assert.throws(
                () => validateLanguagePack({ ...manifest, ...change }),
                /Invalid language pack/
            );
        }
        assert.deepEqual(
            JSON.parse(await readFile(join(manager.directory, 'python-test.json'), 'utf8')),
            manifest
        );
    } finally {
        await cleanup(root);
    }
});

test(
    'installed pack supplies diagnostics and completion, reload preserves clients, disable stops and re-enable restarts',
    { timeout: 30000 },
    async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-pack-rpc-')));
        let session: Session | undefined;
        try {
            const directory = join(root, 'packs');
            await mkdir(directory);
            await writeFile(join(directory, 'python.json'), JSON.stringify(manifest));
            await writeFile(join(root, 'main.py'), 'print("hello")\n');
            const config = await discoverLanguagePacks(resources, directory);
            session = await Session.create(root, () => {}, resources, config);
            const lua = (code: string): Promise<unknown> =>
                session!.client.request('nvim_exec_lua', [code, []]);
            await session.openFile('main.py');
            assert.equal(
                await lua("vim.wait(100); return #vim.lsp.get_clients({name='python_pack_test'})"),
                0,
                'root markers must be required'
            );
            await writeFile(join(root, 'pyproject.toml'), '');
            await writeFile(join(root, 'other.py'), 'print("other")\n');
            await session.openFile('other.py');
            assert.equal(
                await lua(
                    'return vim.wait(5000, function() return #vim.diagnostic.get(0) == 1 end, 20)'
                ),
                true
            );
            const clientId = await lua(
                "return vim.lsp.get_clients({name='python_pack_test'})[1].id"
            );
            assert.equal(
                await lua(`local client = vim.lsp.get_clients({bufnr=0, name='python_pack_test'})[1]
local response = client:request_sync('textDocument/completion', vim.lsp.util.make_position_params(0, client.offset_encoding), 3000, 0)
return response.result[1].label`),
                'pack_completion'
            );
            assert.equal(
                (await session.languagePacks()).find((pack) => pack.id === manifest.id)?.status,
                'running'
            );
            await session.reloadLanguagePacks(config);
            assert.equal(
                await lua("return vim.lsp.get_clients({name='python_pack_test'})[1].id"),
                clientId
            );
            const minimal = structuredClone(config);
            const minimalPack = minimal.packs.find((pack) => pack.id === manifest.id)!;
            delete minimalPack.settings;
            delete minimalPack.initOptions;
            await session.reloadLanguagePacks(minimal);
            assert.equal(
                await lua(
                    'return vim.lsp.config.python_pack_test.settings == nil and vim.lsp.config.python_pack_test.init_options == nil'
                ),
                true,
                'Removed settings must not leak into the next server'
            );
            await lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'unsaved edit'})");
            await session.reloadLanguagePacks({ ...config, disabled: [manifest.id] });
            assert.equal(
                await lua(
                    "return vim.wait(3000, function() return #vim.lsp.get_clients({name='python_pack_test'}) == 0 end, 20)"
                ),
                true
            );
            assert.equal(
                await lua('return vim.bo.modified and vim.api.nvim_get_current_line()'),
                'unsaved edit'
            );
            assert.equal(
                (await session.languagePacks()).find((pack) => pack.id === manifest.id)?.status,
                'disabled'
            );
            await session.reloadLanguagePacks(config);
            assert.equal(
                await lua(
                    "return vim.wait(5000, function() local client = vim.lsp.get_clients({bufnr=0, name='python_pack_test'})[1]; return client and client.initialized and client.id ~= " +
                        clientId +
                        ' end, 20)'
                ),
                true
            );
            await session.reloadLanguagePacks({
                ...config,
                packs: config.packs.filter((pack) => pack.id !== manifest.id)
            });
            assert.equal(
                (await session.languagePacks()).some((pack) => pack.id === manifest.id),
                false
            );
        } finally {
            await session?.stop();
            await cleanup(root);
        }
    }
);

test(
    'built-in TypeScript toggles live while other pack changes preserve its running client',
    { timeout: 20000 },
    async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-pack-typescript-')));
        let session: Session | undefined;
        try {
            await writeFile(join(root, 'main.ts'), 'const total: number = "wrong";\n');
            const config = await discoverLanguagePacks(resources);
            session = await Session.create(root, () => {}, resources, config);
            await session.openFile('main.ts');
            const lua = (code: string): Promise<unknown> =>
                session!.client.request('nvim_exec_lua', [code, []]);
            const ready =
                'return vim.wait(5000, function() return #vim.diagnostic.get(0, {severity=vim.diagnostic.severity.ERROR}) > 0 end, 20)';
            assert.equal(await lua(ready), true);
            const id = await lua("return vim.lsp.get_clients({name='typescript'})[1].id");
            await session.reloadLanguagePacks({ ...config, disabled: ['rust'] });
            assert.equal(await lua("return vim.lsp.get_clients({name='typescript'})[1].id"), id);
            await session.reloadLanguagePacks({ ...config, disabled: ['typescript'] });
            assert.equal(
                await lua(
                    "return vim.wait(3000, function() return #vim.lsp.get_clients({name='typescript'}) == 0 end, 20)"
                ),
                true
            );
            assert.equal(await lua('return vim.bo.filetype'), 'typescript');
            await session.reloadLanguagePacks(config);
            assert.equal(await lua(ready), true);
            assert.notEqual(await lua("return vim.lsp.get_clients({name='typescript'})[1].id"), id);
        } finally {
            await session?.stop();
            await cleanup(root);
        }
    }
);

test(
    'missing tools and a crashing language server report failures without breaking editing',
    { timeout: 15000 },
    async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-pack-errors-')));
        let session: Session | undefined;
        try {
            await writeFile(join(root, 'main.py'), 'original\n');
            const config = await discoverLanguagePacks(resources);
            config.packs.push({
                ...manifest,
                bundled: false,
                rootMarkers: undefined,
                command: ['nido-no-such-tool-123']
            });
            session = await Session.create(root, () => {}, resources, config);
            assert.equal(
                (await session.languagePacks()).find((pack) => pack.id === manifest.id)?.status,
                'missing'
            );
            config.packs[config.packs.length - 1] = {
                ...manifest,
                bundled: false,
                rootMarkers: undefined,
                command: [
                    process.execPath,
                    resolve('tests/fixtures/language-pack-server.mjs'),
                    '--ready-file',
                    join(root, 'server-ready')
                ]
            };
            await session.reloadLanguagePacks(config);
            await session.openFile('main.py');
            assert.equal(
                await session.client.request('nvim_exec_lua', [
                    "return vim.wait(5000, function() for _, pack in ipairs(require('nido_language_packs').snapshot()) do if pack.id == 'python-test' then return pack.status == 'error' end end end, 20)",
                    []
                ]),
                true
            );
            await writeFile(join(root, 'server-ready'), '');
            await session.reloadLanguagePacks(config);
            assert.equal(
                await session.client.request('nvim_exec_lua', [
                    "return vim.wait(5000, function() local client = vim.lsp.get_clients({bufnr=0, name='python_pack_test'})[1]; return client and client.initialized end, 20)",
                    []
                ]),
                true,
                'Reload must retry a failed server without changing its manifest'
            );
            await session.paste('still editable');
            await session.save();
            assert.match(await readFile(join(root, 'main.py'), 'utf8'), /still editable/);
        } finally {
            await session?.stop();
            await cleanup(root);
        }
    }
);

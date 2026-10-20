import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Session } from '../src/main/session';
import { SearchMatcher } from '../src/main/searchMatcher';
import { defaultSearchOptions } from '../src/shared/search';

async function fixture(check: (session: Session, root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'nido-replacement-'));
    let session: Session | undefined;
    try {
        session = await Session.create(root, () => {});
        await session.attach(80, 24);
        await check(session, root);
    } finally {
        await session?.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

test('selected-line replacement previews without writes, preserves BOM/CRLF and undo, and edits unopened buffers', () =>
    fixture(async (session, root) => {
        const originals = [
            '\uFEFF日本語 needle needle\r\nskip needle\r\n',
            'needle without final newline'
        ];
        for (let index = 0; index < originals.length; index++)
            await writeFile(join(root, `${index}.txt`), originals[index]);
        const active = await session.client.request('nvim_exec_lua', [
            'return vim.api.nvim_get_current_buf()',
            []
        ]);
        const result = await session.searchText('needle', defaultSearchOptions);
        assert.equal(result.matches.length, 3);
        assert.equal(result.matches[0].column, 11);
        const preview = await session.previewReplacement(result.token!, '置換$1', [0, 2]);
        assert.equal(preview.count, 3);
        assert.equal(preview.files.length, 2);
        assert.match(preview.files[0].after, /置換\$1 置換\$1/);
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                'return vim.api.nvim_get_current_buf()',
                []
            ]),
            active
        );
        for (let index = 0; index < originals.length; index++)
            assert.equal(await readFile(join(root, `${index}.txt`), 'utf8'), originals[index]);
        assert.deepEqual(await session.applyReplacement(preview.token), { count: 3, files: 2 });
        assert.equal(
            await session.client.request('nvim_exec_lua', [
                'return vim.api.nvim_get_current_buf()',
                []
            ]),
            active
        );
        await assert.rejects(session.applyReplacement(preview.token), /Search results changed/);
        await session.saveAll();
        assert.equal(
            await readFile(join(root, '0.txt'), 'utf8'),
            '\uFEFF日本語 置換$1 置換$1\r\nskip needle\r\n'
        );
        assert.equal(await readFile(join(root, '1.txt'), 'utf8'), '置換$1 without final newline');
        for (let index = 0; index < originals.length; index++) {
            await session.openFile(`${index}.txt`, 1, 1);
            await session.input('u');
            await session.inputMode();
            await session.save();
            assert.equal(await readFile(join(root, `${index}.txt`), 'utf8'), originals[index]);
        }
    }));

test('regex captures, Unicode word boundaries, case and folder options respect Git ignores', () =>
    fixture(async (session, root) => {
        execFileSync('git', ['init', '-q', root], { windowsHide: true });
        await mkdir(join(root, 'src'));
        await mkdir(join(root, 'ignored'));
        await writeFile(join(root, '.gitignore'), 'ignored/\n');
        await writeFile(join(root, 'src', 'match.txt'), '日本語 foo12 FOO34 foo12suffix 猫foo12\n');
        await writeFile(join(root, 'other.txt'), 'foo12\n');
        await writeFile(join(root, 'ignored', 'secret.txt'), 'foo12\n');
        const options = {
            ...defaultSearchOptions,
            regex: true,
            caseSensitive: false,
            wholeWord: true,
            folder: 'src'
        };
        const result = await session.searchText('(foo)(\\d+)', options);
        assert.equal(result.matches.length, 1);
        const preview = await session.previewReplacement(result.token!, '$2-$1', [0]);
        assert.equal(preview.count, 2);
        assert.match(preview.files[0].after, /12-foo 34-FOO foo12suffix 猫foo12/);
        await session.applyReplacement(preview.token);
        await session.saveAll();
        assert.equal(
            await readFile(join(root, 'src', 'match.txt'), 'utf8'),
            '日本語 12-foo 34-FOO foo12suffix 猫foo12\n'
        );
        assert.equal(
            (await session.searchText('foo12', { ...defaultSearchOptions, folder: 'ignored' }))
                .matches.length,
            0
        );
        await assert.rejects(session.searchText('[', options), /Invalid regular expression/);
        await assert.rejects(
            session.searchText('foo', { ...options, folder: '../' }),
            /inside this workspace/
        );
        const end = await session.searchText('$', { ...options, wholeWord: false });
        assert.equal(end.matches.length, 1, 'a final newline must not add a phantom row');
    }));

test('replacement rejects unsaved or externally changed targets before touching any file', () =>
    fixture(async (session, root) => {
        await writeFile(join(root, 'a.txt'), 'needle\n');
        await writeFile(join(root, 'z.txt'), 'needle\n');
        await session.openFile('z.txt');
        const search = (): ReturnType<Session['searchText']> =>
            session.searchText('needle', defaultSearchOptions);
        let result = await search();
        await session.input('iDRAFT<Esc>');
        await session.inputMode();
        await assert.rejects(
            session.previewReplacement(result.token!, 'changed', [0, 1]),
            /Save unsaved/
        );
        await session.input('u');
        await session.inputMode();
        result = await search();
        let preview = await session.previewReplacement(result.token!, 'changed', [0, 1]);
        await writeFile(join(root, 'z.txt'), 'external\n');
        await assert.rejects(session.applyReplacement(preview.token), /Search results changed/);
        assert.equal(await session.modified(), false);
        assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'needle\n');
        await writeFile(join(root, 'z.txt'), 'needle\n');
        result = await search();
        preview = await session.previewReplacement(result.token!, 'changed', [0, 1]);
        await session.input('iDRAFT<Esc>');
        await session.inputMode();
        await assert.rejects(session.applyReplacement(preview.token), /Save unsaved/);
        const buffers = (await session.client.request('nvim_exec_lua', [
            "local result = {}; for _, buf in ipairs(vim.api.nvim_list_bufs()) do result[vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':t')] = vim.api.nvim_buf_get_lines(buf, 0, -1, false) end; return result",
            []
        ])) as Record<string, string[]>;
        assert.deepEqual(buffers['a.txt'], ['needle']);
        assert.deepEqual(buffers['z.txt'], ['DRAFTneedle']);
    }));

test('search cancellation invalidates replacement previews and replacement cannot be replayed', () =>
    fixture(async (session, root) => {
        await writeFile(join(root, 'one.txt'), 'needle\n');
        const result = await session.searchText('needle', defaultSearchOptions);
        const preview = await session.previewReplacement(result.token!, '', [0]);
        session.cancelFindFiles();
        await assert.rejects(session.applyReplacement(preview.token), /Search results changed/);
        await assert.rejects(
            session.previewReplacement(result.token!, 'x', [0]),
            /Search results changed/
        );
        assert.equal(await readFile(join(root, 'one.txt'), 'utf8'), 'needle\n');
    }));

test('slow regex can time out or cancel while the main event loop remains responsive', async () => {
    const options = { ...defaultSearchOptions, regex: true };
    const matcher = new SearchMatcher('(a+)+$', options);
    let responsive = false;
    const timer = setTimeout(() => {
        responsive = true;
    }, 25);
    try {
        await assert.rejects(matcher.find('a'.repeat(80) + '!'), /took too long/);
        assert.equal(responsive, true);
    } finally {
        clearTimeout(timer);
        matcher.close();
    }
    const cancelled = new SearchMatcher('(a+)+$', options);
    const running = cancelled.find('a'.repeat(80) + '!');
    cancelled.close();
    await assert.rejects(running, /cancelled/);
});

test('replacement preserves mixed/CR-only endings, empty files and Unicode zero-width matches', () =>
    fixture(async (session, root) => {
        const originals = ['needle\r\nneedle\nneedle\r\n', 'needle\rneedle\r', '', '猫猫'];
        for (let index = 0; index < originals.length; index++)
            await writeFile(join(root, `${index}.txt`), originals[index]);
        const result = await session.searchText('^', { ...defaultSearchOptions, regex: true });
        const preview = await session.previewReplacement(
            result.token!,
            'x',
            result.matches.map((_, index) => index)
        );
        await session.applyReplacement(preview.token);
        await session.saveAll();
        const expected = ['xneedle\r\nxneedle\nxneedle\r\n', 'xneedle\rxneedle\r', 'x', 'x猫猫'];
        for (let index = 0; index < originals.length; index++)
            assert.equal(await readFile(join(root, `${index}.txt`), 'utf8'), expected[index]);
        const zero = await session.searchText('(?=猫)', { ...defaultSearchOptions, regex: true });
        const second = await session.previewReplacement(zero.token!, '🐈', [0]);
        assert.equal(second.count, 2);
        await session.applyReplacement(second.token);
        await session.saveAll();
        assert.equal(await readFile(join(root, '3.txt'), 'utf8'), 'x🐈猫🐈猫');
    }));

test('an empty replacement deletes matches without changing final newline or BOM', () =>
    fixture(async (session, root) => {
        const originals = ['needle', 'needle\n', '\uFEFFneedle\r\n'];
        const expected = ['', '\n', '\uFEFF\r\n'];
        for (let index = 0; index < originals.length; index++) {
            await writeFile(join(root, `${index}.txt`), originals[index]);
        }
        const result = await session.searchText('needle', defaultSearchOptions);
        const preview = await session.previewReplacement(result.token!, '', [0, 1, 2]);
        await session.applyReplacement(preview.token);
        await session.saveAll();
        for (let index = 0; index < originals.length; index++) {
            assert.equal(await readFile(join(root, `${index}.txt`), 'utf8'), expected[index]);
        }
    }));

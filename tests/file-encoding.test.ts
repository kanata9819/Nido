import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/main/session/session';

// 日本語 in Shift_JIS (CP932), and café in Latin-1. Neither is valid UTF-8.
const japanese = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

test('files that are not UTF-8 are read as Shift_JIS when they decode as one, else Latin-1, and saved back unchanged in encoding', async () => {
	const root = await mkdtemp(join(tmpdir(), 'nido-encoding-'));
	let session: Session | undefined;
	try {
		await writeFile(join(root, 'japanese.txt'), japanese);
		await writeFile(join(root, 'latin.txt'), latin);
		await writeFile(join(root, 'utf8.txt'), '日本語\n');
		session = await Session.create(root, () => {});
		const lua = (code: string): Promise<unknown> =>
			session!.client.request('nvim_exec_lua', [code, []]);
		for (const [file, encoding, text] of [
			['japanese.txt', 'cp932', '日本語'],
			['latin.txt', 'latin1', 'café'],
			['utf8.txt', 'utf-8', '日本語']
		]) {
			await session.openFile(file);
			assert.equal(await lua('return vim.bo.fileencoding'), encoding, file);
			assert.equal(await lua('return vim.fn.getline(1)'), text, file);
		}

		// An edit to the Shift_JIS file is saved in Shift_JIS, not converted to UTF-8.
		await session.openFile('japanese.txt');
		await lua("vim.api.nvim_buf_set_lines(0, 0, 1, false, {'日本語です'})");
		await session.save();
		assert.deepEqual(
			await readFile(join(root, 'japanese.txt')),
			Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xc5, 0x82, 0xb7, 0x0a])
		);
	} finally {
		await session?.stop();
		await rm(root, { recursive: true, force: true });
	}
});

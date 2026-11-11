import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NeovimClient } from 'neovim';
import { SessionFiles } from '../src/main/sessionFiles';
import { SearchMatcher } from '../src/main/searchMatcher';
import { defaultSearchOptions } from '../src/shared/search';

for (const folder of [false, true]) {
	for (const modified of [false, true]) {
		test(`rename protects a ${modified ? 'modified hidden buffer' : 'tab'} at an unopened ${folder ? 'folder child' : 'file'} destination`, async () => {
			const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-move-target-')));
			try {
				if (folder) await mkdir(join(root, 'source'));
				const source = folder ? 'source/file.txt' : 'source.txt';
				const destination = folder ? 'target/file.txt' : 'target.txt';
				await writeFile(join(root, source), 'source contents\n');
				const client = {
					request: async (_method: string, args: unknown[]) => {
						if (String(args[0]).includes('local result = {}')) {
							return [
								{
									id: 1,
									name: join(root, destination),
									listed: !modified,
									modified
								}
							];
						}
						return false;
					}
				} as unknown as NeovimClient;
				const files = new SessionFiles(root, client);
				await assert.rejects(
					files.fileAction(
						'rename',
						folder ? 'source' : source,
						folder ? 'target' : destination,
						async () => {}
					),
					/Close the destination file tab first/
				);
				assert.equal(await readFile(join(root, source), 'utf8'), 'source contents\n');
				await assert.rejects(stat(join(root, folder ? 'target' : destination)), {
					code: 'ENOENT'
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
}

test('saved-text search keeps embedded CR characters inside LF and CRLF rows', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'nido-search-cr-')));
	try {
		const files = new SessionFiles(root, {} as NeovimClient);
		for (const text of [
			'prefix\rneedle\nnext\n',
			'prefix\rneedle\r\nnext\r\n',
			'prefix\rneedle\r\nnext\n'
		]) {
			await writeFile(join(root, 'sample.txt'), text);
			for (const options of [undefined, defaultSearchOptions]) {
				const result = await files.searchText('needle', options);
				assert.deepEqual(
					result.matches.map(({ line, column }) => ({ line, column })),
					[{ line: 1, column: 8 }]
				);
			}
			const anchored = await files.searchText('^needle', {
				...defaultSearchOptions,
				regex: true
			});
			assert.deepEqual(anchored.matches, [], 'An embedded CR must not introduce a row.');
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('selected-line replacement includes matches on both sides of an embedded CR', async () => {
	const matcher = new SearchMatcher('needle', defaultSearchOptions);
	try {
		const text = 'needle\rneedle\nlast\n';
		assert.deepEqual(
			(await matcher.find(text)).map(({ line }) => line),
			[1]
		);
		assert.deepEqual(await matcher.replace(text, [1], 'changed'), {
			text: 'changed\rchanged\nlast\n',
			count: 2
		});
	} finally {
		matcher.close();
	}
});

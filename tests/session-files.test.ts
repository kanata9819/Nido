import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NeovimClient } from 'neovim';
import { SessionFiles } from '../src/main/sessionFiles';

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

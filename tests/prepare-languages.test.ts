import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { prepareLanguages } from '../scripts/prepare-languages';

async function fixture(): Promise<{
	root: string;
	directory: string;
	modules: string;
	install: () => Promise<void>;
	installs: () => number;
}> {
	const root = await mkdtemp(join(tmpdir(), 'nido-language-setup-'));
	const directory = join(root, 'resources/languages');
	const modules = join(directory, 'node_modules');
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'package.json'), '{"dependencies":{"typescript":"6.0.3"}}');
	await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
	let installs = 0;
	return {
		root,
		directory,
		modules,
		installs: () => installs,
		install: async () => {
			installs++;
			await rm(modules, { recursive: true, force: true });
			for (const file of [
				'.package-lock.json',
				'typescript/package.json',
				'typescript/lib/tsserver.js',
				'typescript-language-server/package.json',
				'typescript-language-server/lib/cli.mjs'
			]) {
				await mkdir(dirname(join(modules, file)), { recursive: true });
				await writeFile(join(modules, file), '{}');
			}
		}
	};
}

test('language preparation reuses a complete installation and supports a forced repair', async () => {
	const setup = await fixture();
	try {
		assert.equal(await prepareLanguages(setup.root, setup), true);
		assert.equal(await prepareLanguages(setup.root, setup), false);
		assert.equal(setup.installs(), 1);
		assert.equal(await prepareLanguages(setup.root, { ...setup, force: true }), true);
		assert.equal(setup.installs(), 2);
	} finally {
		await rm(setup.root, { recursive: true, force: true });
	}
});

for (const change of [
	'package.json',
	'package-lock.json',
	'node_modules/.package-lock.json',
	'node_modules/typescript/package.json',
	'node_modules/typescript-language-server/package.json'
]) {
	test(`language preparation reinstalls after ${change} changes`, async () => {
		const setup = await fixture();
		try {
			await prepareLanguages(setup.root, setup);
			await writeFile(join(setup.directory, change), '{"changed":true}');
			assert.equal(await prepareLanguages(setup.root, setup), true);
			assert.equal(await prepareLanguages(setup.root, setup), false);
			assert.equal(setup.installs(), 2);
		} finally {
			await rm(setup.root, { recursive: true, force: true });
		}
	});
}

for (const missing of [
	'.package-lock.json',
	'typescript/lib/tsserver.js',
	'typescript-language-server/lib/cli.mjs'
]) {
	test(`language preparation repairs a missing ${missing}`, async () => {
		const setup = await fixture();
		try {
			await prepareLanguages(setup.root, setup);
			await rm(join(setup.modules, missing));
			assert.equal(await prepareLanguages(setup.root, setup), true);
			assert.equal(setup.installs(), 2);
		} finally {
			await rm(setup.root, { recursive: true, force: true });
		}
	});
}

test('failed language preparation leaves no marker and retries on the next run', async () => {
	const setup = await fixture();
	try {
		await prepareLanguages(setup.root, setup);
		await assert.rejects(
			prepareLanguages(setup.root, {
				force: true,
				install: () => {
					throw new Error('offline');
				}
			}),
			/offline/
		);
		await assert.rejects(readFile(join(setup.modules, '.nido-prepared')), { code: 'ENOENT' });
		assert.equal(await prepareLanguages(setup.root, setup), true);
	} finally {
		await rm(setup.root, { recursive: true, force: true });
	}
});

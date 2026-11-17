import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyName } from '../src/renderer/src/explorer/explorerPaths';

test('a copy pasted beside its original gets " copy" before the extension, or after a dotfile or folder name', () => {
	assert.equal(copyName('notes.txt', false), 'notes copy.txt');
	assert.equal(copyName('archive.tar.gz', false), 'archive.tar copy.gz');
	assert.equal(copyName('Makefile', false), 'Makefile copy');
	// A leading dot starts the name, not an extension.
	assert.equal(copyName('.gitignore', false), '.gitignore copy');
	assert.equal(copyName('.env.local', false), '.env copy.local');
	// A folder's dots are part of its name.
	assert.equal(copyName('my.folder', true), 'my.folder copy');
	// Later copies are numbered, as for files dropped onto a taken name.
	assert.equal(copyName('notes.txt', false, 2), 'notes copy 2.txt');
	assert.equal(copyName('assets', true, 3), 'assets copy 3');
	assert.equal(copyName('src', true), 'src copy');
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LayoutCheckpoints } from '../src/main/workspace/layoutCheckpoints';
import { readLayout, writeLayout } from '../src/main/workspace/persistence';
import type { WorkspaceRegistry } from '../src/main/workspace/workspaceRegistry';
import type { AppState } from '../src/main/ipc/handlers';
import type { SavedWorkspace } from '../src/shared/types';

test('the final layout keeps the window as it was when quitting began', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'nido-layout-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const bounds = { width: 1000, height: 700 };
	let maximized = false;
	const window = Object.assign(new EventEmitter(), {
		getNormalBounds: () => ({ ...bounds }),
		isMaximized: () => maximized,
		isDestroyed: () => false
	});
	let finishSnapshot = (): void => {};
	const saved: SavedWorkspace = { root, files: [], current: '' };
	const registry = {
		orderedIds: () => ['a'],
		sessions: new Map(),
		snapshotOf: () =>
			new Promise<SavedWorkspace>((resolve) => {
				finishSnapshot = () => resolve(saved);
			})
	} as unknown as WorkspaceRegistry;
	const state: AppState = {
		order: ['a'],
		active: 'a',
		restoration: undefined,
		prompting: true,
		closing: false
	};
	const path = join(root, 'workspaces.json');
	const checkpoints = new LayoutCheckpoints(window as never, state, registry, path, () => {});
	context.after(() => void window.emit('closed'));
	// The workspace was restored, so the final layout is written.
	checkpoints.start();

	const final = checkpoints.saveFinal();
	await new Promise((resolve) => setImmediate(resolve));
	// The window changes while a slow Neovim snapshot is still being taken.
	bounds.width = 400;
	maximized = true;
	finishSnapshot();
	await final;

	const layout = await readLayout(path);
	assert.deepEqual(layout.window, { width: 1000, height: 700, maximized: false });
	assert.equal(layout.workspaces.length, 1);
});

test('a close refreshes the backup even when a background checkpoint already saved the layout', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'nido-layout-backup-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, 'workspaces.json');
	const bounds = { width: 1000, height: 700 };
	await writeLayout(path, {
		version: 1,
		active: 0,
		window: { ...bounds, maximized: false },
		workspaces: [{ root, current: '', files: [] }]
	});
	const window = Object.assign(new EventEmitter(), {
		getNormalBounds: () => bounds,
		isMaximized: () => false,
		isDestroyed: () => false
	});
	const state: AppState = {
		order: [],
		active: '',
		restoration: undefined,
		prompting: false,
		closing: false
	};
	const registry = { orderedIds: () => [], sessions: new Map() } as unknown as WorkspaceRegistry;
	const errors: unknown[] = [];
	context.mock.timers.enable({ apis: ['setInterval'] });
	const checkpoints = new LayoutCheckpoints(window as never, state, registry, path, (error) =>
		errors.push(error)
	);
	context.after(() => void window.emit('closed'));
	checkpoints.start();
	context.mock.timers.tick(5000);

	// Let the normal checkpoint finish after the tab disappeared, before close requests
	// a write that also clears it from the backup.
	const deadline = Date.now() + 2000;
	while ((await readLayout(path)).workspaces.length && Date.now() < deadline) {
		await delay(10);
	}
	assert.deepEqual((await readLayout(path)).workspaces, []);
	assert.equal(JSON.parse(await readFile(path + '.bak', 'utf8')).workspaces.length, 1);
	await checkpoints.saveReplacingBackup();
	assert.deepEqual(errors, []);
	assert.deepEqual(JSON.parse(await readFile(path + '.bak', 'utf8')), await readLayout(path));
});

test('quitting before any workspace was restored keeps the saved layout and its backup', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'nido-layout-early-quit-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, 'workspaces.json');
	const saved = {
		version: 1 as const,
		active: 0,
		window: { width: 1000, height: 700, maximized: false },
		workspaces: [
			{
				root,
				current: join(root, 'notes.md'),
				files: [{ path: join(root, 'notes.md'), line: 3, column: 0 }],
				untitled: [
					{
						id: '00000000-0000-4000-8000-000000000000:2',
						index: 2,
						lines: ['unsaved draft'],
						endOfLine: true,
						fileformat: 'unix' as const,
						line: 1,
						column: 0
					}
				]
			}
		]
	};
	await writeLayout(path, saved, { replaceBackup: true });
	const window = Object.assign(new EventEmitter(), {
		getNormalBounds: () => ({ width: 1000, height: 700 }),
		isMaximized: () => false,
		isDestroyed: () => false
	});
	// After a crash restart, the renderer has not asked for the restoration yet.
	const registry = {
		orderedIds: () => [],
		sessions: new Map(),
		snapshotOf: () => assert.fail('No workspace is open to snapshot.')
	} as unknown as WorkspaceRegistry;
	const state: AppState = {
		order: [],
		active: '',
		restoration: undefined,
		prompting: true,
		closing: false
	};
	const checkpoints = new LayoutCheckpoints(window as never, state, registry, path, () => {});
	context.after(() => void window.emit('closed'));

	await checkpoints.saveFinal();

	assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), saved);
	assert.deepEqual(JSON.parse(await readFile(path + '.bak', 'utf8')), saved);
});

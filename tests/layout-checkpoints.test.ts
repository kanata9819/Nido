import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LayoutCheckpoints } from '../src/main/workspace/layoutCheckpoints';
import { readLayout } from '../src/main/workspace/persistence';
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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Session } from '../src/main/session';
import type { AppState } from '../src/main/handlers';
import type { LanguagePackConfiguration } from '../src/shared/languagePacks';
import type { NidoEvent, Workspace } from '../src/shared/types';

const testRequire = createRequire(__filename);
const electronPath = testRequire.resolve('electron');
const electron = new Module(electronPath);
let userData: string;
electron.exports = { app: { getPath: () => userData } };
electron.loaded = true;
testRequire.cache[electronPath] = electron;

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

interface WakeFixture {
	wake: () => Promise<unknown>;
	setEnabled: (enabled: boolean) => Promise<void>;
	restoring: Promise<void>;
	restore: () => void;
	config: () => LanguagePackConfiguration | undefined;
	sessions: Map<string, Session>;
	current: Session;
	state: AppState;
	sleepingFiles: () => string[];
	sent: NidoEvent[];
	stopped: () => boolean;
	onReload: (action: () => Promise<void>) => void;
}

async function fixture(context: TestContext): Promise<WakeFixture> {
	const root = await mkdtemp(join(tmpdir(), 'nido-wake-packs-'));
	userData = root;
	const { Session } = await import('../src/main/session');
	const { LanguagePacks } = await import('../src/main/languagePacks');
	const { registerWorkspaceHandlers } = await import('../src/main/workspaceHandlers');
	const { registerLanguagePackHandlers } = await import('../src/main/languagePackHandlers');
	const resources = join(root, 'resources');
	const bundled = join(resources, 'nido/language-packs');
	await mkdir(bundled, { recursive: true });
	await writeFile(
		join(bundled, 'sample.json'),
		JSON.stringify({
			schemaVersion: 1,
			id: 'sample',
			version: '1.0.0',
			title: 'Sample',
			description: 'Test pack',
			filetypes: ['sample'],
			serverName: 'sample_ls',
			command: ['sample-language-server']
		})
	);
	const packs = new LanguagePacks(resources, root);
	const workspace = { id: 'background', root, name: 'Background' };
	const snapshot = {
		root,
		files: [{ path: join(root, 'file.txt'), line: 1, column: 0 }],
		current: ''
	};
	const previous = {
		workspace,
		canSleep: async () => true,
		snapshot: async () => snapshot,
		stop: async () => {}
	} as unknown as Session;
	const sessions = new Map([['background', previous]]);
	const state: AppState = {
		order: ['background'],
		active: 'selected',
		restoration: undefined,
		prompting: false,
		closing: false
	};
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const window = Object.assign(new EventEmitter(), { isDestroyed: () => false });
	const sent: NidoEvent[] = [];
	const handle = (name: string, action: (...args: unknown[]) => unknown): void => {
		handlers.set(name, action);
	};
	const { sleepingFiles } = registerWorkspaceHandlers({
		window,
		sessions,
		state,
		neovimResources: resources,
		languagePacks: packs,
		send: (event: NidoEvent) => sent.push(event),
		handle,
		session: (id: unknown) => {
			const session = sessions.get(String(id));
			assert.ok(session);
			return session;
		},
		text: String,
		shellChoice: () => 'auto',
		captureHistory: async () => {}
	} as never);
	registerLanguagePackHandlers({
		window,
		sessions,
		state,
		send: (event: NidoEvent) => sent.push(event),
		handle,
		languagePacks: packs
	} as never);
	const restoring = gate();
	const restored = gate();
	let config: LanguagePackConfiguration | undefined;
	let stopped = false;
	let reload: () => Promise<void> = async () => {};
	const current = {
		workspace,
		restore: async () => {
			restoring.release();
			await restored.promise;
			return [];
		},
		reloadLanguagePacks: async (value: LanguagePackConfiguration) => {
			config = value;
			await reload();
		},
		stop: async () => {
			stopped = true;
		}
	} as unknown as Session;
	const create = Session.create;
	Session.create = async (_root, emit, _resources, value) => {
		config = value;
		emit({
			type: 'state',
			id: workspace.id,
			state: { buffers: [], current: 0, mode: 'n', line: 1, column: 1, filetype: '' }
		});
		return current;
	};
	context.after(async () => {
		Session.create = create;
		restored.release();
		window.emit('closed');
		await rm(root, { recursive: true, force: true });
	});
	assert.equal(await handlers.get('sleep')!('background'), true);
	return {
		wake: () => handlers.get('wake')!('background') as Promise<unknown>,
		setEnabled: (enabled: boolean) =>
			handlers.get('setLanguagePackEnabled')!('sample', enabled) as Promise<void>,
		restoring: restoring.promise,
		restore: restored.release,
		config: () => config,
		sessions,
		current,
		state,
		sleepingFiles,
		sent,
		stopped: () => stopped,
		onReload: (action: () => Promise<void>) => {
			reload = action;
		}
	};
}

test('pack updates still reach a session whose final wake reload is pending', async (context) => {
	const check = await fixture(context);
	const reloading = gate();
	const finished = gate();
	context.after(finished.release);
	let first = true;
	check.onReload(async () => {
		if (first) {
			first = false;
			reloading.release();
			await finished.promise;
		}
	});
	const waking = check.wake();
	await check.restoring;
	check.restore();
	await reloading.promise;
	assert.equal(check.sessions.get('background'), check.current);
	assert.deepEqual(check.sent, [], 'Startup events must stay buffered until settings are ready.');
	await check.setEnabled(false);
	finished.release();
	await waking;
	assert.deepEqual(check.config()!.disabled, ['sample']);
});

test('a failed final pack reload keeps the workspace asleep and permits retry', async (context) => {
	const check = await fixture(context);
	check.onReload(async () => {
		throw new Error('Pack reload failed');
	});
	check.restore();
	await assert.rejects(check.wake(), /Pack reload failed/);
	assert.equal(check.sessions.has('background'), false);
	assert.equal(check.stopped(), true);
	assert.equal(check.sleepingFiles().length, 1);
	assert.deepEqual(check.sent, []);
	check.onReload(async () => {});
	await check.wake();
	assert.equal(check.sessions.get('background'), check.current);
	assert.deepEqual(check.sleepingFiles(), []);
});

test('closing during the final pack reload cancels the wake without releasing startup events', async (context) => {
	const check = await fixture(context);
	check.onReload(async () => {
		check.state.closing = true;
	});
	check.restore();
	await assert.rejects(check.wake(), /The window is closing/);
	assert.equal(check.sessions.has('background'), false);
	assert.equal(check.stopped(), true);
	assert.equal(check.sleepingFiles().length, 1);
	assert.deepEqual(check.sent, []);
});

for (const enabled of [false, true]) {
	test(`waking applies a language pack ${enabled ? 'enabled' : 'disabled'} while restoring`, async (context) => {
		const check = await fixture(context);
		await check.setEnabled(!enabled);
		const waking = check.wake();
		await check.restoring;
		assert.equal(check.sessions.has('background'), false);
		await check.setEnabled(enabled);
		check.restore();
		await waking;
		assert.equal(check.config()!.disabled.includes('sample'), !enabled);
		assert.equal(check.sessions.get('background'), check.current);
		assert.deepEqual(check.sleepingFiles(), []);
	});
}

async function restorationFixture(context: TestContext): Promise<{
	restore: () => NonNullable<AppState['restoration']>;
	create: () => Promise<Workspace>;
	layout: (ids: string[], active: string) => void;
	sleep: (id: string) => Promise<boolean>;
	close: (id: string) => Promise<boolean>;
	created: () => number;
	onRestore: (action: () => Promise<string[]>) => void;
}> {
	const root = await mkdtemp(join(tmpdir(), 'nido-renderer-restore-'));
	userData = root;
	await writeFile(
		join(root, 'workspaces.json'),
		JSON.stringify({ version: 1, workspaces: [{ root, files: [], current: '' }], active: 0 })
	);
	const { Session } = await import('../src/main/session');
	const { registerWorkspaceHandlers } = await import('../src/main/workspaceHandlers');
	const sessions = new Map<string, Session>();
	const state: AppState = {
		order: [],
		active: '',
		restoration: undefined,
		prompting: false,
		closing: false
	};
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const window = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		isFocused: () => true,
		isMaximized: () => false,
		getNormalBounds: () => ({ width: 1000, height: 700 })
	});
	let created = 0;
	let restore = async (): Promise<string[]> => [];
	const create = Session.create;
	Session.create = async () => {
		const workspace = { id: `workspace-${++created}`, root, name: `Workspace ${created}` };
		return {
			workspace,
			running: true,
			restore: () => restore(),
			reloadLanguagePacks: async () => {},
			setFocus: () => {},
			modified: async () => false,
			canSleep: async () => true,
			snapshot: async () => ({ root, files: [], current: '' }),
			client: { request: async () => ({ blocking: false }) },
			stop: async () => {}
		} as unknown as Session;
	};
	registerWorkspaceHandlers({
		window,
		sessions,
		state,
		neovimResources: root,
		languagePacks: { load: async () => ({}) },
		send: () => {},
		handle: (name: string, action: (...args: unknown[]) => unknown) =>
			handlers.set(name, action),
		session: (id: unknown) => {
			const current = sessions.get(String(id));
			assert.ok(current);
			return current;
		},
		text: String,
		shellChoice: () => 'auto',
		captureHistory: async () => {}
	} as never);
	context.after(async () => {
		Session.create = create;
		window.emit('closed');
		await rm(root, { recursive: true, force: true });
	});
	return {
		restore: () => handlers.get('restore')!() as NonNullable<AppState['restoration']>,
		create: () => handlers.get('create')!(root, 'editor') as Promise<Workspace>,
		layout: (ids, active) => {
			handlers.get('layout')!(ids, active);
		},
		sleep: (id) => handlers.get('sleep')!(id) as Promise<boolean>,
		close: (id) => handlers.get('close')!(id) as Promise<boolean>,
		created: () => created,
		onRestore: (action) => {
			restore = action;
		}
	};
}

test('renderer restoration reflects newly created tabs, their order and the current selection', async (context) => {
	const check = await restorationFixture(context);
	const first = await check.restore();
	const added = await check.create();
	check.layout([added.id, first.active], added.id);
	const current = await check.restore();
	assert.deepEqual(
		current.workspaces.map(({ id }) => id),
		[added.id, first.active]
	);
	assert.equal(current.active, added.id);
	assert.equal(check.created(), 2, 'Reconnecting must reuse the live sessions.');
});

test('renderer restoration reports slept tabs and excludes closed tabs', async (context) => {
	const check = await restorationFixture(context);
	const first = await check.restore();
	const selected = await check.create();
	check.layout([first.active, selected.id], selected.id);
	assert.equal(await check.sleep(first.active), true);
	assert.equal(
		(await check.restore()).workspaces.find(({ id }) => id === first.active)?.sleeping,
		true
	);
	assert.equal(await check.close(first.active), true);
	assert.deepEqual(
		(await check.restore()).workspaces.map(({ id }) => id),
		[selected.id]
	);
	assert.equal(await check.close(selected.id), true);
	assert.deepEqual(await check.restore(), { workspaces: [], active: '', errors: [] });
});

test('concurrent renderer restorations share startup and retain restoration errors', async (context) => {
	const check = await restorationFixture(context);
	const starting = gate();
	const finished = gate();
	context.after(finished.release);
	check.onRestore(async () => {
		starting.release();
		await finished.promise;
		return ['A saved file is unavailable.'];
	});
	const first = check.restore();
	const second = check.restore();
	await starting.promise;
	assert.equal(check.created(), 1);
	finished.release();
	const results = await Promise.all([first, second]);
	assert.deepEqual(results[0], results[1]);
	assert.equal(results[0].workspaces.length, 1);
	assert.deepEqual(results[0].errors, ['A saved file is unavailable.']);
	assert.equal(check.created(), 1);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Session } from '../src/main/session';
import type { AppState } from '../src/main/handlers';

// These tests exercise the real IPC handler without launching an Electron window.
const testRequire = createRequire(__filename);
const electronPath = testRequire.resolve('electron');
const electron = new Module(electronPath);
let userData: string;
electron.exports = { app: { getPath: () => userData } };
electron.loaded = true;
testRequire.cache[electronPath] = electron;

async function fixture(context: TestContext): Promise<{
	sleep: () => Promise<unknown>;
	current: Session;
	sessions: Map<string, Session>;
	state: AppState;
	busy: { modified: boolean; mode: string };
	onSnapshot: (run: () => void) => void;
	onCapture: (run: () => void) => void;
	onRecheck: (run: () => void) => void;
	stopped: () => boolean;
	filesAsleep: () => string[];
}> {
	const root = await mkdtemp(join(tmpdir(), 'nido-sleep-handler-'));
	userData = root;
	const { registerWorkspaceHandlers } = await import('../src/main/workspaceHandlers');
	const { Session } = await import('../src/main/session');
	const busy = { modified: false, mode: 'n' };
	const state: AppState = {
		order: ['background'],
		active: 'selected',
		restoration: undefined,
		prompting: false,
		closing: false
	};
	let checkCount = 0;
	let stopped = false;
	let snapshot = (): void => {};
	let capture = (): void => {};
	let recheck = (): void => {};
	const current = {
		workspace: { id: 'background', name: 'Background', root },
		state: { buffers: [] },
		canSleep: Session.prototype.canSleep,
		sleepBlocker: Session.prototype.sleepBlocker,
		modified: async () => busy.modified,
		client: {
			request: async () => {
				if (++checkCount === 2) recheck();
				return { mode: busy.mode, blocking: false };
			}
		},
		snapshot: async () => {
			snapshot();
			return {
				root,
				files: [{ path: join(root, 'file.txt'), line: 1, column: 0 }],
				current: ''
			};
		},
		stop: async () => {
			stopped = true;
		}
	} as unknown as Session;
	const sessions = new Map([['background', current]]);
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const window = Object.assign(new EventEmitter(), { isDestroyed: () => false });
	const { sleepingFiles } = registerWorkspaceHandlers({
		window,
		sessions,
		state,
		neovimResources: root,
		languagePacks: { load: async () => ({}) },
		send: () => {},
		handle: (name: string, action: (...args: unknown[]) => unknown) =>
			handlers.set(name, action),
		session: (id: unknown) => sessions.get(String(id)),
		text: String,
		shellChoice: () => 'auto',
		captureHistory: async () => capture()
	} as never);
	context.after(async () => {
		window.emit('closed');
		await rm(root, { recursive: true, force: true });
	});
	return {
		sleep: () => handlers.get('sleep')!('background') as Promise<unknown>,
		current,
		sessions,
		state,
		busy,
		stopped: () => stopped,
		filesAsleep: sleepingFiles,
		onSnapshot: (run) => {
			snapshot = run;
		},
		onCapture: (run) => {
			capture = run;
		},
		onRecheck: (run) => {
			recheck = run;
		}
	};
}

for (const stage of ['snapshot', 'capture'] as const) {
	for (const change of ['modified', 'mode', 'debug', 'terminal'] as const) {
		test(`sleep preserves a workspace that becomes ${change} during ${stage}`, async (context) => {
			const check = await fixture(context);
			const mutate = (): void => {
				if (change === 'modified') check.busy.modified = true;
				if (change === 'mode') check.busy.mode = 'i';
				if (change === 'debug') check.current.state.debug = { status: 'running' } as never;
				if (change === 'terminal') check.current.terminal = {} as Session;
			};
			if (stage === 'snapshot') check.onSnapshot(mutate);
			else check.onCapture(mutate);
			// The handler reports what keeps the workspace running.
			assert.equal(await check.sleep(), change);
			assert.equal(check.stopped(), false);
			assert.equal(check.sessions.get('background'), check.current);
			assert.deepEqual(check.filesAsleep(), []);
		});
	}
}

for (const change of ['selected', 'prompting', 'closing', 'replaced'] as const) {
	test(`sleep cancels when the workspace becomes ${change} during the final eligibility check`, async (context) => {
		const check = await fixture(context);
		check.onRecheck(() => {
			if (change === 'selected') check.state.active = 'background';
			if (change === 'prompting') check.state.prompting = true;
			if (change === 'closing') check.state.closing = true;
			if (change === 'replaced') check.sessions.set('background', {} as Session);
		});
		assert.equal(await check.sleep(), false);
		assert.equal(check.stopped(), false);
		assert.deepEqual(check.filesAsleep(), []);
	});
}

test('a workspace that remains idle sleeps after its final eligibility check', async (context) => {
	const check = await fixture(context);
	assert.equal(await check.sleep(), true);
	assert.equal(check.stopped(), true);
	assert.equal(check.sessions.has('background'), false);
	assert.equal(check.filesAsleep().length, 1);
});

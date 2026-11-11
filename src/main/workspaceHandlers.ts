import { app, dialog } from 'electron';
import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Session } from './session';
import { readLayout, writeLayout, type SavedLayout } from './persistence';
import { WorkspaceCheckpoints } from './workspaceCheckpoints';
import { registerFavoriteHandlers } from './favoriteHandlers';
import { registerFolderBrowserHandlers } from './folderBrowserHandlers';
import type { NidoEvent, SavedWorkspace, TerminalShell, Workspace } from '../shared/types';
import { parseWslPath } from '../shared/wsl';
import type { HandlerDeps } from './handlers';
import { createTranslator } from '../shared/i18n';
import type { LanguagePacks } from './languagePacks';
import { untitledRecoveryLimitMessage } from '../shared/recovery';

interface PrestartedLayout {
	saved: SavedLayout;
	starts: ({ created: Promise<Session>; claim: () => void } | undefined)[];
}

/**
 * Whether a saved workspace can start asleep: anything but the selected tab, unless it
 * runs a shell or carries unsaved untitled text that only a running Neovim holds.
 */
export function startsAsleep(saved: SavedWorkspace, index: number, active: number): boolean {
	return (
		index !== active && saved.kind !== 'terminal' && !saved.terminal && !saved.untitled?.length
	);
}

/** Hold events until release, then deliver them in order and pass later ones through. */
export function bufferedEmitter(send: (event: NidoEvent) => void): {
	emit: (event: NidoEvent) => void;
	release: () => void;
} {
	let held: NidoEvent[] | undefined = [];
	return {
		emit: (event) => (held ? held.push(event) : send(event)),
		release: () => {
			const events = held ?? [];
			held = undefined;
			events.forEach(send);
		}
	};
}

export function registerWorkspaceHandlers({
	window,
	sessions,
	state,
	neovimResources,
	languagePacks,
	send,
	handle,
	session,
	text,
	shellChoice,
	captureHistory
}: HandlerDeps & {
	languagePacks: LanguagePacks;
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	session: (id: unknown) => Session;
	text: (value: unknown) => string;
	shellChoice: (value?: unknown) => TerminalShell;
	captureHistory: (session: Session) => Promise<void>;
}): {
	prepareToQuit: () => Promise<boolean>;
	/** Files that sleeping workspaces had open, which they reopen when they wake. */
	sleepingFiles: () => string[];
} {
	const layoutPath = join(app.getPath('userData'), 'workspaces.json');
	let checkpointReady = false;
	let replaceBackup = false;
	// Sleeping workspaces keep their tab and a snapshot, but no Neovim process.
	const sleeping = new Map<string, { workspace: Workspace; saved: SavedWorkspace }>();
	// A sleeping workspace's Neovim exits quietly; the renderer keeps its tab.
	const muted = new Set<string>();
	const quiet =
		(emit: (event: NidoEvent) => void) =>
		(event: NidoEvent): void => {
			const target = 'id' in event ? event.id : undefined;
			if (!target || !muted.has(target)) {
				emit(event);
			}
		};
	const sessionSend = quiet(send);
	// Sleep and wake of one workspace run one after another.
	const transitions = new Map<string, Promise<unknown>>();
	const exclusive = <T>(id: string, task: () => Promise<T>): Promise<T> => {
		const next = (transitions.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
		transitions.set(id, next);
		void next
			.finally(() => {
				if (transitions.get(id) === next) {
					transitions.delete(id);
				}
			})
			.catch(() => {});
		return next;
	};
	const known = (id: string): boolean => sessions.has(id) || sleeping.has(id);
	const orderedIds = (): string[] => [
		...state.order.filter(known),
		...[...sessions.keys(), ...sleeping.keys()].filter((id) => !state.order.includes(id))
	];
	const snapshotOf = (
		id: string,
		options: { restoreScroll?: boolean; includeUntitled?: boolean }
	): Promise<SavedWorkspace> => {
		const asleep = sleeping.get(id);
		return asleep ? Promise.resolve(asleep.saved) : session(id).snapshot(options);
	};
	const sleepingWorkspace = (saved: SavedWorkspace): Workspace => {
		const remote = parseWslPath(saved.root);
		return {
			id: randomUUID(),
			root: saved.root,
			name: basename(saved.root) || saved.root,
			...(remote ? { wsl: remote.distribution } : {})
		};
	};
	const windowLayout = (): { width: number; height: number; maximized: boolean } => ({
		width: window.getNormalBounds().width,
		height: window.getNormalBounds().height,
		maximized: window.isMaximized()
	});
	const canCheckpoint = (): boolean =>
		checkpointReady && !state.prompting && !state.closing && !window.isDestroyed();
	const checkpoints = new WorkspaceCheckpoints(
		async () => {
			if (!canCheckpoint()) {
				return;
			}
			const ids = orderedIds();
			const active = state.active;
			const current = ids.filter((id) => sessions.has(id)).map((id) => session(id));
			let workspaces: SavedWorkspace[];
			try {
				// Fast mode queries remain available while Vim waits for a prompt or a key.
				const modes = await Promise.all(
					current.map((s) => s.client.request('nvim_get_mode', []))
				);
				if (modes.some((mode: { blocking: boolean }) => mode.blocking)) {
					return;
				}
				workspaces = await Promise.all(
					ids.map((id) =>
						snapshotOf(id, {
							restoreScroll: false,
							includeUntitled: state.historyEnabled !== false
						})
					)
				);
			} catch (error) {
				// A workspace closed or put to sleep meanwhile cancels its requests. The next
				// checkpoint sees the new layout, so this one is skipped instead of reported.
				if (current.some((s) => !s.running || sessions.get(s.workspace.id) !== s)) {
					return;
				}
				throw error;
			}
			if (
				!canCheckpoint() ||
				active !== state.active ||
				JSON.stringify(ids) !== JSON.stringify(orderedIds())
			) {
				return;
			}
			return {
				version: 1,
				window: windowLayout(),
				workspaces,
				active: Math.max(0, ids.indexOf(active))
			};
		},
		async (layout) => {
			const replace = replaceBackup;
			await writeLayout(layoutPath, layout, { replaceBackup: replace });
			if (replace) {
				replaceBackup = false;
			}
		},
		(error) =>
			send({
				type: 'notification',
				id: state.active,
				title: 'Workspace recovery',
				message: String(error).includes(untitledRecoveryLimitMessage)
					? untitledRecoveryLimitMessage
					: String(error),
				severity: 'error'
			})
	);
	const checkpointTimer = setInterval(() => void checkpoints.save(), 5000);
	checkpointTimer.unref();
	window.once('closed', () => {
		clearInterval(checkpointTimer);
		checkpoints.dispose();
	});
	registerFavoriteHandlers({ handle, text });

	async function confirmClose(s: Session): Promise<boolean> {
		if (!(await s.modified())) {
			return true;
		}
		const t = createTranslator(state.language ?? 'en');
		const { response } = await dialog.showMessageBox(window, {
			type: 'warning',
			title: t('Unsaved changes'),
			message: t('Save changes in {name}?', { name: s.workspace.name }),
			detail: t(
				'Save all files before closing this workspace. Untitled buffers need a filename (:w path).'
			),
			buttons: [t('Save all'), t('Cancel'), t('Discard changes')],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		});
		if (response === 1) {
			return false;
		}
		if (response === 0) {
			await s.saveAll();
		}
		return true;
	}

	// Ordinary close and update restart share the same save and session shutdown sequence.
	async function prepareToQuit(): Promise<boolean> {
		if (state.closing) {
			return true;
		}
		if (state.prompting) {
			return false;
		}
		state.prompting = true;
		try {
			if (state.restoration) {
				await state.restoration;
			}
			for (const s of sessions.values()) {
				if (!(await confirmClose(s))) {
					return false;
				}
			}
			await Promise.all([...sessions.values()].map(captureHistory));
			// A background write must finish before the final shutdown snapshot replaces it.
			await checkpoints.idle();
			const ids = orderedIds();
			await writeLayout(
				layoutPath,
				{
					version: 1,
					window: windowLayout(),
					workspaces: await Promise.all(
						ids.map((id) => snapshotOf(id, { includeUntitled: false }))
					),
					active: Math.max(0, ids.indexOf(state.active))
				},
				{ replaceBackup: true }
			);
			await Promise.all([...sessions.values()].map((s) => s.stop()));
			state.closing = true;
			return true;
		} finally {
			state.prompting = false;
		}
	}
	window.on('close', (event) => {
		if (state.closing) {
			return;
		}
		event.preventDefault();
		void prepareToQuit()
			.then((ready) => {
				if (ready) {
					window.close();
				}
			})
			.catch((error: unknown) =>
				dialog.showMessageBox(window, { type: 'error', message: String(error) })
			);
	});

	// Start the saved workspaces' Neovim processes while the renderer is still loading.
	// Their events wait until the renderer asks for the restoration and has subscribed.
	let prestart: Promise<PrestartedLayout> | undefined = (async () => {
		const saved = await readLayout(layoutPath);
		return {
			saved,
			starts: saved.workspaces.map((workspace, index) => {
				if (startsAsleep(workspace, index, saved.active)) {
					return undefined;
				}
				const events = bufferedEmitter(sessionSend);
				const created = languagePacks
					.load()
					.then((packs) =>
						Session.create(workspace.root, events.emit, neovimResources, packs)
					);
				// Restoration reports the failure; avoid an unhandled rejection before it claims this.
				created.catch(() => {});
				return { created, claim: events.release };
			})
		};
	})();
	prestart.catch(() => {});
	window.once('closed', () => {
		// Stop processes the renderer never claimed, such as when it failed to load.
		const unclaimed = prestart;
		prestart = undefined;
		void unclaimed?.then(({ starts }) =>
			starts.forEach(
				(start) =>
					void start?.created.then(
						(s) => s.stop(),
						() => {}
					)
			)
		);
	});

	handle('restore', (shell) => {
		const selectedShell = shellChoice(shell);
		state.restoration ??= (async () => {
			const errors: string[] = [];
			try {
				const early = prestart;
				prestart = undefined;
				const prestarted = early ? await early : undefined;
				const saved = prestarted?.saved ?? (await readLayout(layoutPath));
				sleeping.clear();
				// Independent sessions can start together; insert results in saved tab order.
				const restored = await Promise.all(
					saved.workspaces.map(async (workspace, index) => {
						if (startsAsleep(workspace, index, saved.active)) {
							const asleep = sleepingWorkspace(workspace);
							sleeping.set(asleep.id, { workspace: asleep, saved: workspace });
							return asleep.id;
						}
						let s: Session | undefined;
						try {
							const start = prestarted?.starts[index];
							if (start) {
								start.claim();
								s = await start.created;
							} else {
								s = await Session.create(
									workspace.root,
									sessionSend,
									neovimResources,
									await languagePacks.load()
								);
							}
							errors.push(...(await s.restore(workspace, selectedShell)));
							if (index === saved.active) {
								state.active = s.workspace.id;
							}
							sessions.set(s.workspace.id, s);
							return s.workspace.id;
						} catch (error) {
							await s?.stop();
							errors.push(`${workspace.root}: ${String(error)}`);
							return undefined;
						}
					})
				);
				// A preference may change while independent sessions are starting.
				// Register first so subsequent updates also include these sessions.
				const currentPacks = await languagePacks.load();
				await Promise.all(
					restored.map((id) =>
						id && sessions.has(id)
							? sessions.get(id)!.reloadLanguagePacks(currentPacks)
							: undefined
					)
				);
				state.order = restored.filter((id): id is string => !!id);
				checkpointReady = true;
			} catch (error) {
				errors.push(`Workspace restore failed: ${String(error)}`);
			}
			state.order = orderedIds();
			state.active ||= state.order[0] || '';
			return {
				workspaces: state.order.map((id) =>
					sessions.has(id)
						? session(id).workspace
						: { ...sleeping.get(id)!.workspace, sleeping: true }
				),
				active: state.active,
				errors
			};
		})();
		return state.restoration;
	});

	handle('layout', (ids, selected) => {
		if (
			!Array.isArray(ids) ||
			!ids.every((id) => typeof id === 'string' && known(id)) ||
			new Set(ids).size !== ids.length ||
			typeof selected !== 'string' ||
			(selected !== '' && !ids.includes(selected))
		) {
			throw new Error('Invalid workspace layout.');
		}
		state.order = ids;
		state.active = selected;
	});

	registerFolderBrowserHandlers({ handle, text });

	handle('create', async (path, kind = 'editor', shell) => {
		const selectedShell = shellChoice(shell);
		if (kind !== 'editor' && kind !== 'terminal') {
			throw new Error('Invalid session type.');
		}
		const root = kind === 'terminal' && path === '' ? app.getPath('home') : text(path);
		if (!isAbsolute(root)) {
			throw new Error('Enter an absolute folder path.');
		}
		const s = await Session.create(
			root,
			sessionSend,
			neovimResources,
			await languagePacks.load()
		);
		try {
			if (kind === 'terminal') {
				await s.startTerminal(selectedShell);
			}
			if (state.prompting || state.closing || window.isDestroyed()) {
				throw new Error('The window is closing.');
			}
		} catch (error) {
			await s.stop();
			throw error;
		}
		sessions.set(s.workspace.id, s);
		try {
			await s.reloadLanguagePacks(await languagePacks.load());
		} catch (error) {
			sessions.delete(s.workspace.id);
			await s.stop();
			throw error;
		}
		checkpointReady = true;
		return s.workspace;
	});

	// Stop a background workspace's Neovim, keeping its tab and a snapshot to wake from.
	handle('sleep', (id) => {
		const key = text(id);
		return exclusive(key, async () => {
			const s = sessions.get(key);
			if (
				!s ||
				key === state.active ||
				state.prompting ||
				state.closing ||
				!(await s.canSleep())
			) {
				return false;
			}
			const saved = await s.snapshot({ includeUntitled: true });
			await captureHistory(s);
			// Snapshot and history capture yield to editor activity. A new edit, prompt,
			// debugger or shell must keep the workspace running instead of being discarded.
			if (!(await s.canSleep())) {
				return false;
			}
			// Check again after the last await: the workspace may have been selected meanwhile.
			if (
				key === state.active ||
				state.prompting ||
				state.closing ||
				sessions.get(key) !== s
			) {
				return false;
			}
			muted.add(key);
			sessions.delete(key);
			sleeping.set(key, { workspace: { ...s.workspace }, saved });
			await s.stop();
			return true;
		});
	});

	// Start a sleeping workspace's Neovim again under the same ID and restore its snapshot.
	handle('wake', (id) => {
		const key = text(id);
		return exclusive(key, async () => {
			const asleep = sleeping.get(key);
			if (!asleep) {
				return { workspace: session(key).workspace, errors: [] };
			}
			if (state.prompting || state.closing || window.isDestroyed()) {
				throw new Error('The window is closing.');
			}
			// Hold startup events until the workspace is registered; a failed start stays quiet.
			const events = bufferedEmitter(sessionSend);
			const s = await Session.create(
				asleep.workspace.root,
				events.emit,
				neovimResources,
				await languagePacks.load(),
				key
			);
			let errors: string[];
			try {
				errors = await s.restore(asleep.saved);
				if (state.prompting || state.closing || window.isDestroyed()) {
					throw new Error('The window is closing.');
				}
			} catch (error) {
				await s.stop();
				throw error;
			}
			sleeping.delete(key);
			muted.delete(key);
			sessions.set(key, s);
			events.release();
			return { workspace: s.workspace, errors };
		});
	});

	// Wait for a sleep or wake of the same workspace first: whether it is asleep is only
	// known once that finishes, and a wake that ends meanwhile starts a Neovim to stop.
	handle('close', (id) => {
		const key = text(id);
		return exclusive(key, async () => {
			if (sleeping.delete(key)) {
				muted.delete(key);
				send({ type: 'exit', id: key });
				replaceBackup = true;
				await checkpoints.save();
				return true;
			}
			const s = session(key);
			if (!(await confirmClose(s))) {
				return false;
			}
			await captureHistory(s);
			await s.stop();
			// Neovim's exit already removed the session and told the renderer. Report it here
			// only for a process that never ran, so the renderer hears of the close once.
			if (sessions.delete(s.workspace.id)) {
				send({ type: 'exit', id: s.workspace.id });
			}
			// Do not revive explicitly closed or discarded drafts from a stale checkpoint.
			replaceBackup = true;
			await checkpoints.save();
			return true;
		});
	});
	return {
		prepareToQuit,
		sleepingFiles: () =>
			[...sleeping.values()].flatMap(({ saved }) => saved.files.map((file) => file.path))
	};
}

import { dirname, isAbsolute } from 'node:path';
import { workspaceRelative as relative } from './workspacePaths';
import type { Session } from './session';
import type { NidoEvent } from '../shared/types';
import {
	gitStatus,
	gitDiff,
	gitStage,
	gitStageAll,
	gitCommit,
	gitHistory,
	gitCommitFiles,
	gitCommitDiff,
	gitBranches,
	gitSwitch,
	gitRoot
} from './git';

/** IPC handlers for the Git panel and Git browser. */
export function registerGitHandlers({
	handle,
	session,
	text,
	sessions,
	send
}: {
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	session: (id: unknown) => Session;
	text: (value: unknown) => string;
	sessions: Map<string, Session>;
	send: (event: NidoEvent) => void;
}): void {
	// Concurrent status requests for one folder share a single `git status` run.
	const statusRequests = new Map<string, ReturnType<typeof gitStatus>>();
	const previews = new WeakMap<Session, object>();
	const pendingPreviews = new WeakMap<Session, Promise<string>>();
	// Show one diff at a time per session: a new preview supersedes the previous request, and
	// previews wait for each other so git processes do not pile up while moving through a list.
	function preview(current: Session, read: () => Promise<string>): Promise<string> {
		const request = {};
		previews.set(current, request);
		const pending = (pendingPreviews.get(current) || Promise.resolve())
			.catch(() => {})
			.then(() => {
				if (previews.get(current) !== request) {
					throw new Error('Git preview was superseded.');
				}
				if (sessions.get(current.workspace.id) !== current) {
					throw new Error('Git preview session is closed.');
				}
				return read();
			});
		pendingPreviews.set(current, pending);
		void pending
			.finally(() => {
				if (pendingPreviews.get(current) === pending) {
					pendingPreviews.delete(current);
					previews.delete(current);
				}
			})
			.catch(() => {});
		return pending;
	}
	// After Git changes files or the index, refresh the change marks in the editor and the
	// explorer of each session.
	async function refreshGitState(selected: Iterable<Session> = sessions.values()): Promise<void> {
		for (const open of selected) {
			statusRequests.delete(open.workspace.root);
			try {
				await open.refreshGitSigns();
			} catch (error) {
				send({
					type: 'error',
					id: open.workspace.id,
					message: `Git updated, but editor marks could not refresh: ${String(error)}`
				});
			}
			send({ type: 'filesChanged', id: open.workspace.id });
		}
	}
	handle('gitStatus', (id) => {
		const root = session(id).workspace.root;
		let pending = statusRequests.get(root);
		if (!pending) {
			pending = gitStatus(root).finally(() => {
				if (statusRequests.get(root) === pending) {
					statusRequests.delete(root);
				}
			});
			statusRequests.set(root, pending);
		}
		return pending;
	});
	handle('gitHistory', (id, skip) => {
		if (typeof skip !== 'number') {
			throw new Error('Invalid history offset.');
		}
		return gitHistory(session(id).workspace.root, skip);
	});
	handle('gitCommitFiles', (id, hash) => gitCommitFiles(session(id).workspace.root, text(hash)));
	handle('gitCommitDiff', (id, hash, path) => {
		const current = session(id);
		const commit = text(hash);
		const file = text(path);
		return preview(current, () => gitCommitDiff(current.workspace.root, commit, file));
	});
	handle('gitBranches', (id) => gitBranches(session(id).workspace.root));
	// Switch (or create and switch to) a branch. Refuses while any session that has files from
	// this repository open has unsaved changes, since switching rewrites those files.
	handle('gitSwitch', async (id, name, create) => {
		const current = session(id);
		if (typeof create !== 'boolean') {
			throw new Error('Invalid branch action.');
		}
		const root = await gitRoot(current.workspace.root);
		const affected: Session[] = [];
		for (const open of sessions.values()) {
			// Navigation can open a file from this repository in another project's session.
			const directories = new Set([
				open.workspace.root,
				...open.state.buffers
					// Git resolves Windows short paths and junctions to the repository root.
					// A lexical containment check here would discard those aliases first.
					.filter(({ name }) => isAbsolute(name))
					.map(({ name }) => dirname(name))
			]);
			let sameRepository = open === current;
			for (const directory of directories) {
				if (sameRepository) {
					break;
				}
				const openRoot = await gitRoot(directory).catch(() => undefined);
				sameRepository = openRoot !== undefined && relative(root, openRoot) === '';
			}
			if (!sameRepository) {
				continue;
			}
			affected.push(open);
			if (await open.modified()) {
				throw new Error('Save unsaved editor changes before switching branches.');
			}
		}
		await gitSwitch(current.workspace.root, text(name), create);
		for (const open of affected) {
			await open.refreshFiles();
		}
		await refreshGitState(affected);
	});
	// `staged` chooses between the staged and the unstaged side of a file.
	function stagedFlag(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new Error('Invalid Git selection.');
		}
		return value;
	}
	// Show the diff of one changed file.
	handle('gitDiff', (id, path, staged) => {
		const isStaged = stagedFlag(staged);
		const current = session(id);
		const file = text(path);
		return preview(current, () => gitDiff(current.workspace.root, file, isStaged));
	});
	// Toggle one change: stage it when it is unstaged, unstage it when `staged` is true.
	handle('gitStage', async (id, path, staged) => {
		const isStaged = stagedFlag(staged);
		const current = session(id);
		await gitStage(current.workspace.root, text(path), isStaged);
		await refreshGitState();
	});
	handle('gitStageAll', async (id) => {
		await gitStageAll(session(id).workspace.root);
		await refreshGitState();
	});
	handle('gitCommit', async (id, message) => {
		const result = await gitCommit(session(id).workspace.root, text(message));
		await refreshGitState();
		return result;
	});
}

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
    gitSwitch
} from './git';

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
    async function refreshGitState(): Promise<void> {
        for (const open of sessions.values()) {
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
    handle('gitStatus', (id) => gitStatus(session(id).workspace.root));
    handle('gitHistory', (id, skip) => {
        if (typeof skip !== 'number') {
            throw new Error('Invalid history offset.');
        }
        return gitHistory(session(id).workspace.root, skip);
    });
    handle('gitCommitFiles', (id, hash) => gitCommitFiles(session(id).workspace.root, text(hash)));
    handle('gitCommitDiff', (id, hash, path) =>
        gitCommitDiff(session(id).workspace.root, text(hash), text(path))
    );
    handle('gitBranches', (id) => gitBranches(session(id).workspace.root));
    handle('gitSwitch', async (id, name, create) => {
        const current = session(id);
        if (typeof create !== 'boolean') {
            throw new Error('Invalid branch action.');
        }
        for (const open of sessions.values()) {
            if (await open.modified()) {
                throw new Error('Save unsaved editor changes before switching branches.');
            }
        }
        await gitSwitch(current.workspace.root, text(name), create);
        for (const open of sessions.values()) {
            await open.refreshFiles();
        }
        await refreshGitState();
    });
    for (const [name, action] of [
        ['gitDiff', gitDiff],
        ['gitStage', gitStage]
    ] as const) {
        handle(name, async (id, path, staged) => {
            if (typeof staged !== 'boolean') {
                throw new Error('Invalid Git selection.');
            }
            const result = await action(session(id).workspace.root, text(path), staged);
            if (name === 'gitStage') await refreshGitState();
            return result;
        });
    }
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

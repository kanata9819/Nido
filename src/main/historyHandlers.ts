import { app } from 'electron';
import { join } from 'node:path';
import { HistoryService } from './historyService';
import { LocalHistory } from './localHistory';
import type { HandlerDeps } from './handlers';
import type { Session } from './session';

export function registerHistoryHandlers({
    window,
    sessions,
    state,
    send,
    handle,
    session,
    text
}: HandlerDeps & {
    handle: (name: string, action: (...args: unknown[]) => unknown) => void;
    session: (id: unknown) => Session;
    text: (value: unknown) => string;
}): (session: Session) => Promise<void> {
    const history = new HistoryService(
        new LocalHistory(join(app.getPath('userData'), 'time-machine'))
    );
    const reported = new WeakSet<Session>();
    let busy = false;
    let disposed = false;
    const report = (s: Session, error: unknown): void => {
        if (disposed || window.isDestroyed() || reported.has(s)) {
            return;
        }
        reported.add(s);
        send({
            type: 'notification',
            id: s.workspace.id,
            title: 'Time Machine',
            message: String(error),
            severity: 'error'
        });
    };
    const capture = async (s: Session): Promise<void> => {
        try {
            await history.capture(s);
            reported.delete(s);
        } catch (error) {
            report(s, error);
        }
    };
    const timer = setInterval(() => {
        if (
            busy ||
            disposed ||
            state.prompting ||
            state.closing ||
            state.historyEnabled === false
        ) {
            return;
        }
        busy = true;
        // Keep serialization and disk work bounded even with many independent workspaces.
        void (async () => {
            for (const s of sessions.values()) {
                if (
                    disposed ||
                    state.prompting ||
                    state.closing ||
                    state.historyEnabled === false
                ) {
                    break;
                }
                await capture(s);
            }
        })()
            .finally(() => {
                busy = false;
            })
            .catch(() => {});
    }, 2000);
    timer.unref();
    window.once('closed', () => {
        disposed = true;
        clearInterval(timer);
    });
    handle('historyEnabled', (enabled) => {
        if (typeof enabled !== 'boolean') {
            throw new Error('Invalid history setting.');
        }
        state.historyEnabled = enabled;
    });
    handle('history', (id) => history.list(session(id)));
    handle('historyPreview', (id, path, revision) =>
        history.preview(session(id), text(path), text(revision))
    );
    handle('historyRestore', async (id, path, revision, token) => {
        const s = session(id);
        const archived = await history.restore(s, text(path), text(revision), text(token));
        send({
            type: 'notification',
            id: s.workspace.id,
            title: 'Time Machine',
            message: archived
                ? 'Version restored into the editor. Save when ready.'
                : 'Version restored. History could not be updated; your previous edits are preserved.',
            severity: archived ? 'info' : 'warning'
        });
    });
    return async (s) => {
        if (state.historyEnabled !== false) {
            await capture(s);
        }
    };
}

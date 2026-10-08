import { useLayoutEffect, useRef } from 'react';
import type { Workspace } from '../../src/shared/types';
import { Grid } from '../../src/renderer/src/grid';
import CompletionMenu from '../../src/renderer/src/components/CompletionMenu';
import { useFavoriteWorkspaces } from '../../src/renderer/src/hooks/useFavoriteWorkspaces';
import { useGitFileStatus } from '../../src/renderer/src/hooks/useGitFileStatus';
import {
    useSessionSettings,
    type SessionSettings
} from '../../src/renderer/src/hooks/useSessionSettings';
import { useWorkspaceSessions } from '../../src/renderer/src/hooks/useWorkspaceSessions';

const noop = (): void => {};
export function Favorites({ workspace }: { workspace: Workspace }): React.JSX.Element {
    const favorites = useFavoriteWorkspaces(noop);
    return (
        <>
            <button
                disabled={!favorites.ready || favorites.busy}
                onClick={() => {
                    // Exercise the lock before React can commit the busy state.
                    favorites.toggleFavorite(workspace);
                    favorites.toggleFavorite(workspace);
                }}
            >
                Toggle favorite
            </button>
            <p role="status">{favorites.busy ? 'busy' : 'idle'}</p>
        </>
    );
}

export function GitBadges({ workspaceId }: { workspaceId: string }): React.JSX.Element {
    const badges = useGitFileStatus(workspaceId, [], null);
    const output = useRef<HTMLParagraphElement>(null);
    const commits = useRef(0);
    useLayoutEffect(() => {
        commits.current++;
        output.current?.setAttribute('data-commits', String(commits.current));
    });
    return (
        <p role="status" ref={output}>
            {JSON.stringify(badges)}
        </p>
    );
}

export function Settings({
    workspaces,
    settings
}: {
    workspaces: Workspace[];
    settings: SessionSettings;
}): React.JSX.Element {
    useSessionSettings(workspaces, settings, noop);
    return <p role="status">Ready</p>;
}

export function SessionUpdates(): React.JSX.Element {
    const { states } = useWorkspaceSessions(noop);
    return <p role="status">{JSON.stringify(states)}</p>;
}

export function Completion(): React.JSX.Element {
    const input = useRef<HTMLTextAreaElement>(null);
    const grid = useRef(new Grid());
    return (
        <div style={{ position: 'relative', width: 600, height: 300 }}>
            <textarea aria-label="Neovim input" ref={input} />
            <CompletionMenu
                id="alpha"
                grid={grid}
                input={input}
                fontFamily="monospace"
                onError={noop}
                hidden={false}
            />
        </div>
    );
}

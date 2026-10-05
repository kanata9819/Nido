import { useRef } from 'react';
import type { Workspace } from '../../src/shared/types';
import { Grid } from '../../src/renderer/src/grid';
import CompletionMenu from '../../src/renderer/src/components/CompletionMenu';
import { useFavoriteWorkspaces } from '../../src/renderer/src/hooks/useFavoriteWorkspaces';
import { useGitFileStatus } from '../../src/renderer/src/hooks/useGitFileStatus';

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
    return <p role="status">{JSON.stringify(badges)}</p>;
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

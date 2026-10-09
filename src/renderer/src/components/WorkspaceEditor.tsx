import { memo, useCallback, type ComponentProps } from 'react';
import Editor from '../Editor';
import { WorkspaceWelcome } from './Welcome';

interface Props extends ComponentProps<typeof Editor> {
    empty: boolean;
    onOpenFiles: () => void;
}

// Cursor state belongs to Canvas; only workspace-level changes rerender this subtree.
export default memo(WorkspaceEditor);

function WorkspaceEditor({
    empty,
    onOpenFiles,
    onError,
    onReady,
    id,
    ...props
}: Props): React.JSX.Element {
    const report = useCallback(
        (message: string): void => {
            onReady?.(id);
            onError(message);
        },
        [id, onError, onReady]
    );
    return (
        <Editor {...props} id={id} onReady={onReady} onError={report}>
            {empty && <WorkspaceWelcome onOpen={onOpenFiles} />}
        </Editor>
    );
}

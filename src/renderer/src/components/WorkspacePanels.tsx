import type { SessionState, Workspace } from '../../../shared/types';
import type { BottomPanels } from '../hooks/useBottomPanels';
import DebugPanel from './DebugPanel';
import ReferencesPanel from './ReferencesPanel';

interface Props {
    active: string;
    workspace?: Workspace;
    state: SessionState;
    panels: BottomPanels;
    animations: boolean;
}

export default function WorkspacePanels({
    active,
    workspace,
    state,
    panels,
    animations
}: Props): React.JSX.Element {
    return (
        <>
            {active && state.references && (
                <ReferencesPanel
                    key={active}
                    workspaceId={active}
                    state={state.references}
                    root={workspace?.root || ''}
                    visible={panels.referencesVisible && panels.bottomPanel === 'references'}
                    focusTick={panels.referencesFocusTick}
                    animations={animations}
                    onClose={panels.closeReferences}
                    onOpen={panels.openReference}
                />
            )}
            {active &&
                workspace?.kind !== 'terminal' &&
                panels.debugVisible &&
                panels.bottomPanel === 'debug' && (
                    <DebugPanel
                        state={state.debug}
                        focusTick={panels.debugFocusTick}
                        onClose={panels.closeDebugger}
                        action={panels.debug}
                    />
                )}
        </>
    );
}

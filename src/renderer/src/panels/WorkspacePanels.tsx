import type { SessionState, Workspace } from '../../../shared/types';
import type { BottomPanels } from './useBottomPanels';
import DebugPanel from './DebugPanel';
import ReferencesPanel from './ReferencesPanel';
import referencesStyles from './ReferencesPanel.module.css';

interface Props {
	active: string;
	blocked: boolean;
	workspace?: Workspace;
	state: SessionState;
	panels: BottomPanels;
	animations: boolean;
}

/** The panels below the editor: references and Run and Debug. Only one is shown at a time. */
export default function WorkspacePanels({
	active,
	blocked,
	workspace,
	state,
	panels,
	animations
}: Props): React.JSX.Element {
	return (
		<>
			{active && state.references && (
				// The anchor takes no height: the panel covers the editor instead of resizing it.
				<div className={referencesStyles.referencesAnchor}>
					<ReferencesPanel
						key={active}
						blocked={blocked}
						workspaceId={active}
						state={state.references}
						root={workspace?.root || ''}
						visible={panels.referencesVisible && panels.bottomPanel === 'references'}
						focusTick={panels.referencesFocusTick}
						animations={animations}
						onClose={panels.closeReferences}
						onOpen={panels.openReference}
					/>
				</div>
			)}
			{active &&
				workspace?.kind !== 'terminal' &&
				panels.debugVisible &&
				panels.bottomPanel === 'debug' && (
					<DebugPanel
						blocked={blocked}
						state={state.debug}
						focusTick={panels.debugFocusTick}
						onClose={panels.closeDebugger}
						action={panels.debug}
					/>
				)}
		</>
	);
}

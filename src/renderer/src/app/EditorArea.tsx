// The area beside the explorer: the file tabs, each workspace's editor and terminal, the
// Markdown preview and the Extensions page.
import WorkspaceEditor from '../editor/WorkspaceEditor';
import TerminalPanel from '../panels/TerminalPanel';
import MarkdownPreview from '../panels/MarkdownPreview';
import ExtensionsPage from '../settings/ExtensionsPage';
import KeyboardGuide from '../palette/KeyboardGuide';
import FileHeader from '../layout/FileHeader';
import { Welcome } from '../workspace/Welcome';
import WorkspaceLoading from '../workspace/WorkspaceLoading';
import WorkspaceWakeError from '../workspace/WorkspaceWakeError';
import { defaultFontFamily, type EditorSettings } from '../settings/useEditorSettings';
import type { Decoration } from '../explorer/fileDecorations';
import type { BottomPanels } from '../panels/useBottomPanels';
import type { Item, Panel } from '../types';
import type { SessionState, Workspace } from '../../../shared/types';
import styles from './EditorArea.module.css';

/** The workspace editors' startup: which drew a frame, and which failed to wake. */
export interface EditorStartup {
	initialized: ReadonlySet<string>;
	finishLoading: (id: string) => void;
	wakeFailed: ReadonlyMap<string, string>;
	retryWake: (id: string) => void;
}

interface Props {
	settings: EditorSettings;
	/** The selected workspace, if any, and its session state. */
	workspace: Workspace | undefined;
	state: SessionState;
	active: string;
	/** Workspaces with a running Neovim; each keeps its editor mounted. */
	awakeWorkspaces: Workspace[];
	states: Record<string, SessionState>;
	panel: Panel;
	/** Whether a palette or the leader menu takes the keyboard from the editors. */
	blocked: boolean;
	leader: boolean;
	focusTick: number;
	restoring: boolean;
	creating: boolean;
	startup: EditorStartup;
	panels: BottomPanels;
	commands: Item[];
	decorations: Record<string, Decoration>;
	markdownVisible: boolean;
	create: () => Promise<void>;
	closeWorkspace: (id: string) => void;
	closeMarkdown: () => void;
	openFiles: () => void;
	focusEditor: () => void;
	run: (promise: Promise<unknown>) => void;
	report: (message: string) => void;
}

export default function EditorArea(props: Props): React.JSX.Element {
	const { workspace, state, active, panel, restoring, creating, startup } = props;
	const loading =
		restoring ||
		(!!workspace && !startup.initialized.has(active) && !startup.wakeFailed.has(active));
	return (
		<main id="editor-preview-host" className={styles.main}>
			<div className={styles.editorSplit}>
				<div
					className={styles.editorContent}
					inert={panel === 'extensions'}
					aria-hidden={panel === 'extensions' || undefined}
				>
					{workspace ? (
						<FileHeader
							workspace={workspace}
							buffers={state.buffers}
							current={state.current}
							decorations={props.decorations}
							focusEditor={props.focusEditor}
							restartShell={props.panels.restartShell}
							run={props.run}
						/>
					) : !restoring ? (
						<Welcome creating={creating} create={props.create} />
					) : null}
					<WorkspaceEditors {...props} />
					{loading && <WorkspaceLoading />}
					{workspace && startup.wakeFailed.has(active) && (
						<WorkspaceWakeError
							key={active}
							name={workspace.name}
							message={startup.wakeFailed.get(active)!}
							onRetry={() => startup.retryWake(active)}
							onClose={() => props.closeWorkspace(active)}
						/>
					)}
					<KeyboardGuide
						visible={props.leader}
						commands={props.commands}
						focusEditor={props.focusEditor}
					/>
					<TerminalPanels {...props} />
				</div>
				{props.markdownVisible &&
					workspace?.kind !== 'terminal' &&
					state.filetype === 'markdown' && (
						<MarkdownPreview
							key={active}
							workspaceId={active}
							onClose={props.closeMarkdown}
							focusEditor={props.focusEditor}
						/>
					)}
			</div>
			{panel === 'extensions' && (
				<ExtensionsPage
					onClose={props.focusEditor}
					workspaceId={active || undefined}
					githubEnabled={props.settings.githubEnabled}
					setGithubEnabled={props.settings.setGithubEnabled}
				/>
			)}
		</main>
	);
}

/** One editor per awake workspace; only the selected one is shown. */
function WorkspaceEditors({
	settings,
	awakeWorkspaces,
	states,
	active,
	blocked,
	focusTick,
	startup,
	openFiles,
	report
}: Props): React.JSX.Element[] {
	return awakeWorkspaces.map((w) => (
		<WorkspaceEditor
			key={w.id}
			theme={settings.theme}
			id={w.id}
			terminal={w.kind === 'terminal'}
			active={w.id === active}
			fontSize={settings.fontSize}
			fontWeight={settings.fontWeight}
			lineHeight={settings.lineHeight}
			animations={settings.animations}
			smoothCursor={settings.smoothCursor}
			smoothBlink={settings.smoothBlink}
			scrollFollowCursor={settings.scrollFollowCursor}
			stickyScroll={settings.stickyScroll}
			stickyScrollMaxLines={settings.stickyScrollMaxLines}
			blocked={blocked}
			focusTick={focusTick}
			fontFamily={settings.fontFamily.trim() || defaultFontFamily}
			onReady={startup.finishLoading}
			onError={report}
			empty={w.kind !== 'terminal' && !!states[w.id]?.empty && states[w.id]?.mode === 'n'}
			onOpenFiles={openFiles}
		/>
	));
}

/** The terminal panel of each awake workspace that has opened one. */
function TerminalPanels({
	settings,
	awakeWorkspaces,
	states,
	active,
	blocked,
	panels,
	report
}: Props): React.JSX.Element[] {
	return awakeWorkspaces
		.filter((w) => w.terminalId)
		.map((w) => (
			<TerminalPanel
				key={w.id}
				id={w.terminalId!}
				active={
					w.id === active && panels.terminalVisible && panels.bottomPanel === 'terminal'
				}
				blocked={blocked}
				focusTick={panels.terminalFocusTick}
				copyMode={states[w.terminalId!]?.copyMode}
				shells={states[w.terminalId!]?.terminalShells}
				height={panels.terminalHeight}
				maximized={panels.terminalMaximized}
				settings={settings}
				restartShell={panels.restartShell}
				addShell={panels.addShell}
				selectShell={panels.selectShell}
				closeShell={panels.closeShell}
				resize={panels.resizeTerminal}
				toggleMaximized={panels.toggleTerminalMaximized}
				onError={report}
				onClose={panels.closeTerminal}
			/>
		));
}

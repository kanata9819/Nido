// Root component. It lays out the title bar, sidebar, editors, panels and status bar, and
// holds the active workspace and open panels. Most logic lives in hooks beside each feature,
// such as workspace/useWorkspaceSessions and keyboard/useKeyboardShortcuts; the editor area
// is drawn by EditorArea.tsx.
import { LanguageContext, useI18n } from '../i18n';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import Notification from './Notification';
import NavigationRail from '../layout/NavigationRail';
import { useSessionSettings } from '../settings/useSessionSettings';
import Sidebar from '../explorer/Sidebar';
import { Panel as PanelComponent } from './Panel';
import WorkspacePanels from '../panels/WorkspacePanels';
import { useBottomPanels } from '../panels/useBottomPanels';
import { useWorkspaceActions } from '../workspace/useWorkspaceActions';
import StatusBar from '../layout/StatusBar';
import TitleBar from '../layout/TitleBar';
import { fileDecorations, type Decoration } from '../explorer/fileDecorations';
import { useEditorSettings, type EditorSettings } from '../settings/useEditorSettings';
import { useFavoriteWorkspaces } from '../workspace/useFavoriteWorkspaces';
import { useGitFileStatus } from '../git/useGitFileStatus';
import { useKeyboardShortcuts } from '../keyboard/useKeyboardShortcuts';
import { usePointerVisibility } from './usePointerVisibility';
import { initialSessionState, useWorkspaceSessions } from '../workspace/useWorkspaceSessions';
import type { SessionState, Workspace } from '../../../shared/types';
import { useFocusGuard } from './useFocusGuard';
import { useInitializedEditors } from '../editor/useInitializedEditors';
import { afterEditorClick } from '../editor/editorClick';
import { useWorkspaceSleep } from '../workspace/useWorkspaceSleep';
import styles from './App.module.css';
import { OverlayMotionContext, useReducedMotion } from '../ui/overlayMotion';
import ErrorToast from './ErrorToast';
import { useErrorNotice } from './useErrorNotice';
import { useNativePreferences } from '../settings/useNativePreferences';
import { usePalette } from '../palette/usePalette';
import EditorArea from './EditorArea';
import { useAppCommands } from './useAppCommands';
import { useSleepConfirmation } from './useSleepConfirmation';
import { useOverlayState } from './useOverlayState';
import { useRequests } from './useRequests';

// Provide the language and animation settings to every component.
export default function App(): React.JSX.Element {
	const settings = useEditorSettings();
	const reducedMotion = useReducedMotion();
	return (
		<LanguageContext value={settings.language}>
			<OverlayMotionContext value={settings.animations && !reducedMotion}>
				<AppContent settings={settings} />
			</OverlayMotionContext>
		</LanguageContext>
	);
}

/** The app's layout and the state that ties its parts together. */
function AppContent({ settings }: { settings: EditorSettings }): React.JSX.Element {
	const t = useI18n();
	const pointerHidden = usePointerVisibility();
	const overlays = useOverlayState();
	const { leader, setLeader, dismissLeader, focusTick, requestEditorFocus } = overlays;
	const { notice: errorNotice, error, dismissError, report } = useErrorNotice();
	const closeError = useCallback((): void => {
		dismissError();
		requestEditorFocus();
	}, [dismissError, requestEditorFocus]);

	// Open workspaces, the active workspace ID, and per-workspace state such as the cursor and buffers.
	const { workspaces, setWorkspaces, active, setActive, states, mode, restoring } =
		useWorkspaceSessions(report);
	const { initializedEditors, finishEditorLoading, forgetEditor } = useInitializedEditors();
	const sleep = useWorkspaceSleep({
		workspaces,
		setWorkspaces,
		active,
		restoring,
		forgetEditor,
		report
	});
	// Sleeping workspaces have no Neovim, so they get no editor, explorer or settings yet.
	const awakeWorkspaces = useMemo(() => workspaces.filter((w) => !w.sleeping), [workspaces]);
	const favorites = useFavoriteWorkspaces(report);
	const favoriteBusy = !favorites.ready || favorites.busy;
	const { sidebar, setSidebar, formatOnSave } = settings;
	useNativePreferences(settings, report);
	useSessionSettings(awakeWorkspaces, settings, report);
	const palette = usePalette({
		active,
		report,
		onShow: dismissLeader,
		toggleMarkdown: overlays.toggleMarkdown
	});
	const { panel, closePanel, showPanel, query } = palette;

	const modal = useRef<HTMLDivElement>(null);
	const state = states[active] || initialSessionState;
	const workspace = workspaces.find((w) => w.id === active);
	const { decorations: gitFiles, branch } = useGitFileStatus(
		workspace?.sleeping ? '' : active,
		state.buffers
	);
	const explorerVisible = sidebar && !!workspace && workspace.kind !== 'terminal';
	const captureFocus = useFocusGuard(active);
	const decorations = useMemo(
		() => fileDecorations(workspace?.root || '', gitFiles, state.diagnostics, state.problems),
		[workspace?.root, gitFiles, state.diagnostics, state.problems]
	);
	// Close any overlay and return focus to the editor.
	const focusEditor = useCallback((): void => {
		closePanel();
		setLeader(false);
		requestEditorFocus();
		if (panel === 'extensions' && !active) {
			requestAnimationFrame(() =>
				document.querySelector<HTMLElement>('[data-extensions-trigger]')?.focus()
			);
		}
	}, [panel, active, closePanel, setLeader, requestEditorFocus]);
	const { setMarkdownVisible } = overlays;
	const closeMarkdown = useCallback((): void => {
		setMarkdownVisible(false);
		focusEditor();
	}, [setMarkdownVisible, focusEditor]);
	const { run, runThenFocus } = useRequests({ report, captureFocus, focusEditor });

	const panels = useBottomPanels({
		active,
		workspace,
		state,
		terminalShell: settings.terminalShell,
		setWorkspaces,
		focusEditor,
		captureFocus,
		dismissLeader,
		closeOverlay: () => {
			setLeader(false);
			closePanel();
		},
		run
	});

	const actions = useWorkspaceActions({
		workspaces,
		active,
		restoring,
		terminalShell: settings.terminalShell,
		setWorkspaces,
		setActive,
		focusEditor,
		requestEditorFocus,
		captureFocus,
		dismissLeader,
		showFolders: palette.showFolders,
		closeOverlay: closePanel,
		report,
		run
	});
	const creating = actions.creating || restoring;
	const { requestSleep, confirmation } = useSleepConfirmation({
		workspaces,
		panel,
		sleep: sleep.sleep,
		run,
		report
	});

	const openFile = useCallback(
		(path: string): void => runThenFocus(() => window.nido.openFile(active, path)),
		[active, runThenFocus]
	);
	const openFiles = useCallback((): void => showPanel('files'), [showPanel]);

	/** Show the explorer and focus it. */
	const showExplorer = (): void => {
		if (workspace?.kind === 'terminal') {
			focusEditor();
			return;
		}
		setLeader(false);
		closePanel();
		setSidebar(true);
		requestAnimationFrame(() =>
			document.querySelector<HTMLElement>('aside:not([hidden]) [role="tree"]')?.focus()
		);
	};

	/** Save the current file, formatting it first when format on save is on. */
	const save = (): void =>
		run(afterEditorClick(active, () => window.nido.save(active, formatOnSave)));
	const { commands, filtered } = useAppCommands({
		active,
		panel,
		workspaces,
		fileList: palette.fileList,
		state,
		query,
		runThenFocus,
		callbacks: {
			create: actions.create,
			createTerminal: actions.createTerminal,
			showFavorites: actions.showFavorites,
			activate: actions.activate,
			moveWorkspace: actions.moveWorkspace,
			reorderWorkspace: actions.reorderWorkspace,
			closeWorkspace: actions.closeWorkspace,
			save,
			showPanel,
			run,
			focusEditor,
			captureFocus,
			showExplorer,
			openDebugger: panels.openDebugger,
			openFile,
			toggleFavorite: () => {
				if (workspace) {
					favorites.toggleFavorite(workspace);
				}
			},
			sleepWorkspace: requestSleep,
			isFavorite: favorites.favorites.some(
				(f) => f.root === workspace?.root && f.kind === (workspace?.kind || 'editor')
			),
			githubEnabled: settings.githubEnabled
		}
	});

	// The terminal of the selected workspace: itself for a shell, else the one it opened.
	const terminalId = workspace?.kind === 'terminal' ? active : workspace?.terminalId;
	const keydown = useKeyboardShortcuts({
		save,
		restartShell: () => {
			if (terminalId) {
				panels.restartShell(terminalId);
			}
		},
		terminalCopyMode: () => {
			if (terminalId) {
				run(window.nido.terminalCopyMode(terminalId));
			}
		},
		terminalShell: (action) => {
			const shells = terminalId ? states[terminalId]?.terminalShells : undefined;
			if (!terminalId || !shells) {
				return;
			}
			const count = shells.names.length;
			if (action === 'add') {
				panels.addShell(terminalId);
			} else if (action === 'close') {
				panels.closeShell(terminalId, shells.current);
			} else if (count > 1) {
				const offset = action === 'next' ? 1 : -1;
				panels.selectShell(terminalId, ((shells.current - 1 + offset + count) % count) + 1);
			}
		},
		toggleTerminalMaximized: panels.toggleTerminalMaximized,
		toggleTerminal: panels.toggleTerminal,
		closeReferences: panels.closeReferences,
		showDebugger: panels.showDebugger,
		panel,
		leader,
		error,
		dismissError: closeError,
		focusEditor,
		modal,
		mode,
		active,
		workspaces,
		nextWorkspace: actions.nextWorkspace,
		moveWorkspace: actions.moveWorkspace,
		showExplorer,
		create: actions.create,
		showPanel,
		commands,
		state: { buffers: state.buffers, current: state.current, filetype: state.filetype },
		run,
		setLeader,
		activate: actions.activate
	});

	// Handle shortcuts before any element sees the key (capture phase). Rebinding on every
	// render keeps the handler's view of the state current.
	useLayoutEffect(() => {
		document.addEventListener('keydown', keydown, true);
		return () => document.removeEventListener('keydown', keydown, true);
	});

	const blocked = !!panel || leader;
	return (
		<div
			// nido-app and nido-body let other components' styles depend on these elements'
			// attributes, such as compact mode, from their own CSS modules.
			className={`${styles.app} nido-app`}
			data-animations={settings.animations}
			data-pointer-hidden={pointerHidden}
			data-compact={settings.compactMode}
		>
			<TitleBar
				compact={settings.compactMode}
				workspaces={workspaces}
				favorites={favorites.favorites}
				favoriteBusy={favoriteBusy}
				toggleFavorite={favorites.toggleFavorite}
				active={active}
				creating={creating}
				activate={actions.activate}
				reorderWorkspace={actions.reorderWorkspace}
				closeWorkspace={actions.closeWorkspace}
				create={actions.create}
				createTerminal={actions.createTerminal}
				showPanel={showPanel}
				run={run}
			/>
			<div
				className={`${styles.body} nido-body`}
				data-navigation-position={settings.activityBarPosition}
				data-explorer-visible={explorerVisible}
				style={
					settings.activityBarPosition === 'top' && explorerVisible
						? { gridTemplateColumns: `${settings.sidebarWidth}px minmax(0, 1fr)` }
						: undefined
				}
			>
				<NavigationRail
					position={settings.activityBarPosition}
					sidebar={sidebar}
					active={active}
					panel={panel}
					github={settings.githubEnabled && workspace?.kind !== 'terminal'}
					showExplorer={showExplorer}
					showPanel={showPanel}
				/>
				{sidebar && workspace?.kind !== 'terminal' && (
					<Explorers
						settings={settings}
						awakeWorkspaces={awakeWorkspaces}
						states={states}
						active={active}
						decorations={decorations}
						openFile={openFile}
						report={report}
					/>
				)}
				<EditorArea
					settings={settings}
					workspace={workspace}
					state={state}
					active={active}
					awakeWorkspaces={awakeWorkspaces}
					states={states}
					panel={panel}
					blocked={blocked}
					leader={leader}
					focusTick={focusTick}
					restoring={restoring}
					creating={actions.creating}
					startup={{
						initialized: initializedEditors,
						finishLoading: finishEditorLoading,
						wakeFailed: sleep.failed,
						retryWake: sleep.retry
					}}
					panels={panels}
					commands={commands}
					decorations={decorations}
					markdownVisible={overlays.markdownVisible}
					create={actions.create}
					closeWorkspace={actions.closeWorkspace}
					closeMarkdown={closeMarkdown}
					openFiles={openFiles}
					focusEditor={focusEditor}
					run={run}
					report={report}
				/>
			</div>
			<WorkspacePanels
				active={active}
				blocked={blocked}
				workspace={workspace}
				state={state}
				panels={panels}
				animations={settings.animations}
			/>
			<StatusBar
				onConnect={() => void actions.create()}
				onSearch={(key) => {
					run(window.nido.input(active, '<Esc>' + key));
					focusEditor();
				}}
				active={active}
				workspace={workspace}
				state={state}
				sessionCount={workspaces.length}
				branch={workspace?.kind === 'terminal' ? undefined : branch}
				onBranch={() => showPanel('git')}
				onToggleTerminal={panels.toggleTerminal}
				onToggleDebugger={panels.toggleDebugger}
				onToggleReferences={panels.toggleReferences}
				onLineEnding={(format) => {
					run(window.nido.setLineEnding(active, format));
					focusEditor();
				}}
				onIndentation={() => {
					// The palette lists the indentation commands, so the keyboard reaches them too.
					showPanel('commands');
					palette.setQuery(t('Indentation'));
				}}
			/>
			<Notification workspaceId={active} animations={settings.animations} />
			<ErrorToast
				notice={errorNotice}
				animations={settings.animations}
				dismiss={dismissError}
				onClose={closeError}
			/>
			<PanelComponent
				settings={settings}
				workspaceId={active}
				buffer={state.current}
				symbols={state.symbols}
				initialFolder={workspace?.root || ''}
				folderKind={palette.folderKind}
				folderFavorites={palette.folderFavorites}
				favorites={favorites.favorites}
				favoriteBusy={favoriteBusy}
				openFavorite={actions.openFavorite}
				removeFavorite={favorites.toggleFavorite}
				creating={creating}
				openWorkspace={actions.openWorkspace}
				panel={panel}
				filtered={filtered}
				selection={palette.selection}
				query={query}
				loading={palette.loading}
				modal={modal}
				focusEditor={focusEditor}
				setQuery={palette.setQuery}
				setSelection={palette.setSelection}
				confirmation={confirmation}
			/>
		</div>
	);
}

/** One explorer per awake workspace; only the selected one is shown and decorated. */
function Explorers({
	settings,
	awakeWorkspaces,
	states,
	active,
	decorations,
	openFile,
	report
}: {
	settings: EditorSettings;
	awakeWorkspaces: Workspace[];
	states: Record<string, SessionState>;
	active: string;
	decorations: Record<string, Decoration>;
	openFile: (path: string) => void;
	report: (message: string) => void;
}): React.JSX.Element[] {
	return awakeWorkspaces.map((w) => {
		const state = states[w.id];
		return (
			<Sidebar
				gitFiles={w.id === active ? decorations : {}}
				width={settings.sidebarWidth}
				onResize={settings.resizeSidebar}
				key={w.id}
				workspace={w}
				active={w.id === active}
				currentFile={
					state?.buffers.find((buffer) => buffer.id === state?.current)?.name || ''
				}
				onOpen={openFile}
				onError={report}
			/>
		);
	});
}

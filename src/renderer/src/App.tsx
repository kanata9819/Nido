import { LanguageContext, useI18n } from './i18n';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../../shared/types';
import WorkspaceEditor from './components/WorkspaceEditor';
import TerminalPanel from './components/TerminalPanel';
import Notification from './components/Notification';
import NavigationRail from './components/NavigationRail';
import ExtensionsPage from './components/ExtensionsPage';
import { useSessionSettings } from './hooks/useSessionSettings';
import Sidebar from './Sidebar';
import FileHeader from './components/FileHeader';
import MarkdownPreview from './components/MarkdownPreview';
import KeyboardGuide from './components/KeyboardGuide';
import { Panel as PanelComponent } from './components/Panel';
import WorkspacePanels from './components/WorkspacePanels';
import { useBottomPanels } from './hooks/useBottomPanels';
import { useWorkspaceActions } from './hooks/useWorkspaceActions';
import StatusBar from './components/StatusBar';
import TitleBar from './components/TitleBar';
import { Welcome } from './components/Welcome';
import WorkspaceLoading from './components/WorkspaceLoading';
import { buildItems, buildProblemItems, filterItems } from './commands';
import { fileDecorations } from './fileDecorations';
import {
  defaultFontFamily,
  useEditorSettings,
  type EditorSettings
} from './hooks/useEditorSettings';
import { useFavoriteWorkspaces } from './hooks/useFavoriteWorkspaces';
import { useGitFileStatus } from './hooks/useGitFileStatus';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePointerVisibility } from './hooks/usePointerVisibility';
import { useWorkspaceSessions } from './hooks/useWorkspaceSessions';
import { useFocusGuard } from './hooks/useFocusGuard';
import { useInitializedEditors } from './hooks/useInitializedEditors';
import styles from './assets/Nido.module.css';
import { OverlayMotionContext, useReducedMotion } from './overlayMotion';
import ErrorToast from './components/ErrorToast';
import { useErrorNotice } from './hooks/useErrorNotice';
import { useNativePreferences } from './hooks/useNativePreferences';
import { usePalette } from './hooks/usePalette';

const defaultState: SessionState = {
  buffers: [],
  current: 0,
  mode: 'n',
  line: 1,
  column: 1,
  filetype: ''
};

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

function AppContent({ settings }: { settings: EditorSettings }): React.JSX.Element {
  const t = useI18n();
  const pointerHidden = usePointerVisibility();
  const [markdownVisible, setMarkdownVisible] = useState(false);
  const [leader, setLeader] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const { notice: errorNotice, error, setError, dismissError, report } = useErrorNotice();
  const requestEditorFocus = useCallback(() => setFocusTick((n) => n + 1), []);
  const dismissLeader = useCallback(() => setLeader(false), []);
  const toggleMarkdown = useCallback((): void => {
    setMarkdownVisible((visible) => !visible);
    requestEditorFocus();
  }, [requestEditorFocus]);

  const { workspaces, setWorkspaces, active, setActive, states, mode, restoring } =
    useWorkspaceSessions(report);
  const { initializedEditors, finishEditorLoading } = useInitializedEditors();
  const {
    favorites,
    ready: favoritesReady,
    busy: savingFavorite,
    toggleFavorite
  } = useFavoriteWorkspaces(report);
  const {
    theme,
    sidebar,
    setSidebar,
    animations,
    smoothCursor,
    smoothBlink,
    scrollFollowCursor,
    formatOnSave,
    fontFamily,
    fontWeight,
    fontSize,
    lineHeight,
    sidebarWidth,
    resizeSidebar
  } = settings;
  useNativePreferences(settings, report);
  useSessionSettings(workspaces, settings, report);
  const palette = usePalette({ active, report, onShow: dismissLeader, toggleMarkdown });
  const { panel, closePanel, showPanel, query, fileList } = palette;

  const modal = useRef<HTMLDivElement>(null);
  const state = states[active] || defaultState;
  const gitFiles = useGitFileStatus(active, state.buffers);
  const workspace = workspaces.find((w) => w.id === active);
  const explorerVisible = sidebar && !!workspace && workspace.kind !== 'terminal';
  const captureFocus = useFocusGuard(active);
  const decorations = useMemo(
    () => fileDecorations(workspace?.root || '', gitFiles, state.diagnostics, state.problems),
    [workspace?.root, gitFiles, state.diagnostics, state.problems]
  );
  const focusEditor = useCallback((): void => {
    closePanel();
    setLeader(false);
    requestEditorFocus();
    if (panel === 'extensions' && !active) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-extensions-trigger]')?.focus()
      );
    }
  }, [panel, active, closePanel, requestEditorFocus]);
  const closeMarkdown = useCallback((): void => {
    setMarkdownVisible(false);
    focusEditor();
  }, [focusEditor]);

  const run = useCallback(
    (promise: Promise<unknown>): void => {
      void promise.catch((e) => report(String(e)));
    },
    [report]
  );
  /** Runs a session request, then returns focus to the editor if nothing stole it meanwhile. */
  const runThenFocus = useCallback(
    (request: () => Promise<unknown>): void => {
      const canFocus = captureFocus();
      run(
        request().then(() => {
          if (canFocus()) {
            focusEditor();
          }
        })
      );
    },
    [captureFocus, run, focusEditor]
  );

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
  const { toggleTerminal, restartShell, closeReferences, openDebugger } = panels;

  const {
    creating,
    create,
    createTerminal,
    activate,
    openWorkspace,
    openFavorite,
    nextWorkspace,
    moveWorkspace,
    closeWorkspace
  } = useWorkspaceActions({
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

  const openFile = useCallback(
    (path: string): void => runThenFocus(() => window.nido.openFile(active, path)),
    [active, runThenFocus]
  );
  const openFiles = useCallback((): void => showPanel('files'), [showPanel]);

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

  const save = (): void => run(window.nido.save(active, formatOnSave));
  const openProblem = useCallback(
    (index: number): void =>
      runThenFocus(() => window.nido.openProblem(active, index + 1, state.diagnosticsVersion!)),
    [active, state.diagnosticsVersion, runThenFocus]
  );
  const problemItems = useMemo(
    () => (panel === 'problems' ? buildProblemItems(state.problems, openProblem, t) : []),
    [panel, state.problems, openProblem, t]
  );
  const filteredProblems = useMemo(() => filterItems(problemItems, query), [problemItems, query]);
  const { commands, filtered } = buildItems(
    active,
    panel,
    workspaces,
    fileList,
    state,
    query,
    {
      save,
      showPanel,
      moveWorkspace,
      run,
      focusEditor,
      captureFocus,
      closeWorkspace,
      create,
      createTerminal,
      showExplorer,
      openDebugger,
      openFile,
      activate,
      toggleFavorite: () => {
        if (workspace) {
          toggleFavorite(workspace);
        }
      },
      isFavorite: favorites.some(
        (f) => f.root === workspace?.root && f.kind === (workspace?.kind || 'editor')
      )
    },
    t,
    { items: problemItems, filtered: filteredProblems }
  );

  const keydown = useKeyboardShortcuts({
    save,
    restartShell: () => {
      const id = workspace?.kind === 'terminal' ? active : workspace?.terminalId;
      if (id) {
        restartShell(id);
      }
    },
    toggleTerminal,
    closeReferences,
    showDebugger: panels.showDebugger,
    panel,
    leader,
    error,
    setError,
    setFocusTick,
    focusEditor,
    modal,
    mode,
    active,
    workspaces,
    nextWorkspace,
    showExplorer,
    create,
    showPanel,
    commands,
    state: { buffers: state.buffers, current: state.current, filetype: state.filetype },
    run,
    setLeader,
    activate
  });

  useLayoutEffect(() => {
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  });

  return (
    <div
      className={styles.app}
      data-animations={animations}
      data-pointer-hidden={pointerHidden}
      data-compact={settings.compactMode}
    >
      <TitleBar
        compact={settings.compactMode}
        workspaces={workspaces}
        favorites={favorites}
        favoriteBusy={!favoritesReady || savingFavorite}
        toggleFavorite={toggleFavorite}
        active={active}
        creating={creating || restoring}
        activate={activate}
        closeWorkspace={closeWorkspace}
        create={create}
        createTerminal={createTerminal}
        showPanel={showPanel}
        run={run}
      />
      <div
        className={styles.body}
        data-navigation-position={settings.activityBarPosition}
        data-explorer-visible={explorerVisible}
        style={
          settings.activityBarPosition === 'top' && explorerVisible
            ? { gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }
            : undefined
        }
      >
        <NavigationRail
          position={settings.activityBarPosition}
          sidebar={sidebar}
          active={active}
          panel={panel}
          showExplorer={showExplorer}
          showPanel={showPanel}
        />
        {sidebar &&
          workspace?.kind !== 'terminal' &&
          workspaces.map((w) => (
            <Sidebar
              gitFiles={w.id === active ? decorations : {}}
              width={sidebarWidth}
              onResize={resizeSidebar}
              key={w.id}
              workspace={w}
              active={w.id === active}
              currentFile={
                states[w.id]?.buffers.find((buffer) => buffer.id === states[w.id]?.current)?.name ||
                ''
              }
              onOpen={openFile}
              onError={report}
            />
          ))}
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
                  decorations={decorations}
                  focusEditor={focusEditor}
                  restartShell={restartShell}
                  run={run}
                />
              ) : !restoring ? (
                <Welcome creating={creating} create={create} />
              ) : null}
              {workspaces.map((w) => (
                <WorkspaceEditor
                  key={w.id}
                  theme={theme}
                  id={w.id}
                  terminal={w.kind === 'terminal'}
                  active={w.id === active}
                  fontSize={fontSize}
                  fontWeight={fontWeight}
                  lineHeight={lineHeight}
                  animations={animations}
                  smoothCursor={smoothCursor}
                  smoothBlink={smoothBlink}
                  scrollFollowCursor={scrollFollowCursor}
                  stickyScroll={settings.stickyScroll}
                  stickyScrollMaxLines={settings.stickyScrollMaxLines}
                  blocked={!!panel || leader}
                  focusTick={focusTick}
                  fontFamily={fontFamily.trim() || defaultFontFamily}
                  onReady={finishEditorLoading}
                  onError={report}
                  empty={
                    w.kind !== 'terminal' && !!states[w.id]?.empty && states[w.id]?.mode === 'n'
                  }
                  onOpenFiles={openFiles}
                />
              ))}
              {(restoring || (!!workspace && !initializedEditors.has(active))) && (
                <WorkspaceLoading />
              )}
              <KeyboardGuide visible={leader} commands={commands} focusEditor={focusEditor} />
              {workspaces
                .filter((w) => w.terminalId)
                .map((w) => (
                  <TerminalPanel
                    key={w.id}
                    id={w.terminalId!}
                    name={w.name}
                    active={
                      w.id === active && panels.terminalVisible && panels.bottomPanel === 'terminal'
                    }
                    blocked={!!panel || leader}
                    focusTick={panels.terminalFocusTick}
                    settings={settings}
                    restartShell={restartShell}
                    onError={report}
                    onClose={panels.closeTerminal}
                  />
                ))}
            </div>
            {markdownVisible && workspace?.kind !== 'terminal' && state.filetype === 'markdown' && (
              <MarkdownPreview
                key={active}
                workspaceId={active}
                onClose={closeMarkdown}
                focusEditor={focusEditor}
              />
            )}
          </div>
          {panel === 'extensions' && (
            <ExtensionsPage onClose={focusEditor} workspaceId={active || undefined} />
          )}
        </main>
      </div>
      <WorkspacePanels
        active={active}
        blocked={!!panel || leader}
        workspace={workspace}
        state={state}
        panels={panels}
        animations={animations}
      />
      <StatusBar
        onConnect={() => void create()}
        onSearch={(key) => {
          run(window.nido.input(active, '<Esc>' + key));
          focusEditor();
        }}
        active={active}
        workspace={workspace}
        state={state}
        sessionCount={workspaces.length}
        onToggleTerminal={toggleTerminal}
        onToggleDebugger={panels.toggleDebugger}
        onToggleReferences={panels.toggleReferences}
        onLineEnding={(format) => {
          run(window.nido.setLineEnding(active, format));
          focusEditor();
        }}
      />
      <Notification workspaceId={active} animations={animations} />
      <ErrorToast
        notice={errorNotice}
        animations={animations}
        dismiss={dismissError}
        onClose={() => {
          dismissError();
          requestEditorFocus();
        }}
      />
      <PanelComponent
        settings={settings}
        workspaceId={active}
        buffer={state.current}
        symbols={state.symbols}
        initialFolder={workspace?.root || ''}
        folderKind={palette.folderKind}
        favorites={favorites}
        favoriteBusy={!favoritesReady || savingFavorite}
        openFavorite={openFavorite}
        removeFavorite={toggleFavorite}
        creating={creating || restoring}
        openWorkspace={openWorkspace}
        panel={panel}
        filtered={filtered}
        selection={palette.selection}
        query={query}
        loading={palette.loading}
        modal={modal}
        focusEditor={focusEditor}
        setQuery={palette.setQuery}
        setSelection={palette.setSelection}
      />
    </div>
  );
}

import { Code2 } from 'lucide-react';
import type { Workspace, SessionState } from '../../../shared/types';
import styles from '../assets/Nido.module.css';

interface StatusBarProps {
  active: string;
  workspace?: Workspace;
  state: SessionState;
  sessionCount: number;
  onToggleTerminal: () => void;
  onToggleDebugger: () => void;
  onToggleReferences: () => void;
  onLineEnding: (format: 'LF' | 'CRLF') => void;
}

function modeLabel(mode: string): string {
  switch (mode[0]) {
    case 't':
      return 'TERMINAL';
    case 'i':
      return 'INSERT';
    case 'v':
      return 'VISUAL';
    case 'c':
      return 'COMMAND';
    default:
      return mode === 'V' || mode === '\u0016' ? 'VISUAL' : 'NORMAL';
  }
}

export default function StatusBar({
  active,
  workspace,
  state,
  sessionCount,
  onToggleTerminal,
  onToggleDebugger,
  onToggleReferences,
  onLineEnding
}: StatusBarProps): React.JSX.Element {
  const displayMode = modeLabel(state.mode);
  return (
    <footer className={styles.statusbar}>
      <span className={styles.mode} data-mode={displayMode}>
        {displayMode}
      </span>
      {active && (
        <button aria-label="Toggle terminal" onClick={onToggleTerminal}>
          Terminal
        </button>
      )}
      {active && (
        <button aria-label="Toggle debugger" onClick={onToggleDebugger}>
          Debug
        </button>
      )}
      {state.references && (
        <button aria-label="Toggle references" onClick={onToggleReferences}>
          References
        </button>
      )}
      <span className={styles.statusWorkspace}>{workspace?.name || 'Welcome to Nido'}</span>
      <span className={styles.statusDivider} />
      <span className={styles.sessionCount}>
        {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
      </span>
      <span className={styles.statusGap} />
      {state.lspProgress && (
        <span className={styles.lspProgress} role="status" title={state.lspProgress}>
          <span className={styles.progressSpinner} aria-hidden="true" />
          <span>{state.lspProgress}</span>
        </span>
      )}
      <span>{state.filetype || 'Plain text'}</span>
      {state.filetype === 'rust' && (
        <span title="Rust language server connection">{state.lsp || 'Rust LSP: not connected'}</span>
      )}
      <span>UTF-8</span>
      {active && workspace?.kind !== 'terminal' && state.lineEnding && (
        <select
          className={styles.lineEnding}
          aria-label="Line endings"
          title="Convert line endings (save to apply to disk)"
          value={state.lineEnding}
          onChange={(event) => onLineEnding(event.target.value as 'LF' | 'CRLF')}
        >
          {state.lineEnding === 'Mixed' && (
            <option value="Mixed" disabled>
              Mixed
            </option>
          )}
          {state.lineEnding === 'CR' && (
            <option value="CR" disabled>
              CR
            </option>
          )}
          <option value="LF">LF</option>
          <option value="CRLF">CRLF</option>
        </select>
      )}
      <span>
        Ln {state.line}, Col {state.column}
      </span>
      {active && workspace?.kind !== 'terminal' && state.scrollPercent !== undefined && (
        <span
          className={styles.scrollPosition}
          title="Position in file"
          aria-label={`File position ${state.scrollPercent}%`}
        >
          <span className={styles.scrollTrack} aria-hidden="true">
            <span style={{ width: `${state.scrollPercent}%` }} />
          </span>
          {state.scrollPercent}%
        </span>
      )}
      <Code2 size={15} />
    </footer>
  );
}

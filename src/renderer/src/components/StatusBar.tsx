import { useI18n } from '../i18n';
import { Code2, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
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
    onSearch: (key: 'n' | 'N' | '<Esc>') => void;
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
    onLineEnding,
    onSearch
}: StatusBarProps): React.JSX.Element {
    const t = useI18n();
    const displayMode = modeLabel(state.mode);
    return (
        <footer className={styles.statusbar}>
            <span className={styles.mode} data-mode={t(displayMode)}>
                {t(displayMode)}
            </span>
            {active && (
                <button aria-label={t('Toggle terminal')} onClick={onToggleTerminal}>
                    {t('Terminal')}
                </button>
            )}
            {active && (
                <button aria-label={t('Toggle debugger')} onClick={onToggleDebugger}>
                    {t('Debug')}
                </button>
            )}
            {state.references && (
                <button aria-label={t('Toggle references')} onClick={onToggleReferences}>
                    {t('References')}
                </button>
            )}
            <span className={styles.statusWorkspace}>
                {workspace?.name || t('Welcome to Nido')}
            </span>
            {state.search && (
                <span
                    className={styles.searchStatus}
                    role="status"
                    aria-label={t('Search matches')}
                >
                    <Search size={13} />
                    <strong title={state.search.pattern}>
                        {state.search.pattern.replace(/^\\</, '').replace(/\\>$/, '')}
                    </strong>
                    <span>
                        {state.search.incomplete === 1
                            ? t('Counting…')
                            : `${state.search.current} / ${state.search.total}${state.search.incomplete === 2 ? '+' : ''}`}
                    </span>
                    <button
                        aria-label={t('Previous search match')}
                        title={t('Previous (N)')}
                        onClick={() => onSearch('N')}
                    >
                        <ChevronUp size={14} />
                    </button>
                    <button
                        aria-label={t('Next search match')}
                        title={t('Next (n)')}
                        onClick={() => onSearch('n')}
                    >
                        <ChevronDown size={14} />
                    </button>
                    <button
                        aria-label={t('Clear search highlights')}
                        title={t('Clear (Esc)')}
                        onClick={() => onSearch('<Esc>')}
                    >
                        <X size={13} />
                    </button>
                </span>
            )}
            <span className={styles.statusDivider} />
            <span className={styles.sessionCount}>
                {t(sessionCount === 1 ? '{count} session' : '{count} sessions', {
                    count: sessionCount
                })}
            </span>
            <span className={styles.statusGap} />
            {state.lspProgress && (
                <span className={styles.lspProgress} role="status" title={state.lspProgress}>
                    <span className={styles.progressSpinner} aria-hidden="true" />
                    <span>{state.lspProgress}</span>
                </span>
            )}
            <span>{state.filetype || t('Plain text')}</span>
            {state.filetype === 'rust' && (
                <span title={t('Rust language server connection')}>
                    {state.lsp || t('Rust LSP: not connected')}
                </span>
            )}
            <span>UTF-8</span>
            {active && workspace?.kind !== 'terminal' && state.lineEnding && (
                <select
                    className={styles.lineEnding}
                    aria-label={t('Line endings')}
                    title={t('Convert line endings (save to apply to disk)')}
                    value={state.lineEnding}
                    onChange={(event) => onLineEnding(event.target.value as 'LF' | 'CRLF')}
                >
                    {state.lineEnding === 'Mixed' && (
                        <option value="Mixed" disabled>
                            {t('Mixed')}
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
            <span>{t('Ln {line}, Col {column}', { line: state.line, column: state.column })}</span>
            {active && workspace?.kind !== 'terminal' && state.scrollPercent !== undefined && (
                <span
                    className={styles.scrollPosition}
                    title={t('Position in file')}
                    aria-label={t('File position {percent}%', { percent: state.scrollPercent })}
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

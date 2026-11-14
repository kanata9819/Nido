import progressStyles from '../assets/Progress.module.css';
import { useI18n } from '../i18n';
import type { Translator } from '../../../shared/i18n';
import { Code2, Search, ChevronUp, ChevronDown, X, SquareTerminal } from 'lucide-react';
import type { Workspace, SessionState } from '../../../shared/types';
import styles from '../assets/StatusBar.module.css';
import { indentationLabel } from '../commandItems';

interface StatusBarProps {
	active: string;
	workspace?: Workspace;
	state: SessionState;
	sessionCount: number;
	onToggleTerminal: () => void;
	onConnect: () => void;
	onToggleDebugger: () => void;
	onToggleReferences: () => void;
	onLineEnding: (format: 'LF' | 'CRLF') => void;
	onIndentation: () => void;
	onSearch: (key: 'n' | 'N' | '<Esc>') => void;
}

/**
 * "current / total" of the active search. `incomplete` is 1 until counting finished (or
 * timed out) and 2 when there are more matches than are counted.
 */
function searchCount(
	search: Exclude<SessionState['search'], false | undefined>,
	t: Translator
): string {
	if (search.incomplete === 1) {
		return t('Counting…');
	}
	return `${search.current} / ${search.total}${search.incomplete === 2 ? '+' : ''}`;
}

/** The name of a Neovim mode (as from mode()) for the status bar. */
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

/**
 * The status bar: workspace location, mode, panel toggles, search matches, language server
 * progress, and the current file's indentation, line endings and cursor position.
 */
export default function StatusBar({
	active,
	workspace,
	state,
	sessionCount,
	onConnect,
	onToggleTerminal,
	onToggleDebugger,
	onToggleReferences,
	onLineEnding,
	onIndentation,
	onSearch
}: StatusBarProps): React.JSX.Element {
	const t = useI18n();
	// A terminal in copy mode is in Normal mode, but the user should see that keys select.
	const displayMode = state.copyMode ? 'COPY' : modeLabel(state.mode);
	return (
		<footer className={styles.statusbar}>
			<button
				className={styles.connection}
				aria-label={t('Open a local or WSL workspace')}
				title={workspace?.root || t('Open a local or WSL workspace')}
				onClick={onConnect}
			>
				<SquareTerminal size={14} />
				{workspace?.wsl ? `WSL: ${workspace.wsl}` : t('Local')}
			</button>
			<span className={styles.mode} data-mode={displayMode}>
				{displayMode}
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
					{/* * and # search for \<word\>; show the word without its boundaries. */}
					<strong title={state.search.pattern}>
						{state.search.pattern.replace(/^\\</, '').replace(/\\>$/, '')}
					</strong>
					<span>{searchCount(state.search, t)}</span>
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
					<span className={progressStyles.progressSpinner} aria-hidden="true" />
					<span>{state.lspProgress}</span>
				</span>
			)}
			<span>{state.filetype || t('Plain text')}</span>
			{state.filetype === 'rust' && (
				<span className={styles.lspStatus} title={t('Rust language server connection')}>
					{state.lsp || t('Rust LSP: not connected')}
				</span>
			)}
			{active && workspace?.kind !== 'terminal' && state.indentation && (
				<button
					className={styles.indentation}
					aria-label={t('Indentation: {current}', {
						current: indentationLabel(state.indentation, t)
					})}
					title={t('Change indentation')}
					onClick={onIndentation}
				>
					{indentationLabel(state.indentation, t)}
				</button>
			)}
			<span className={styles.encoding}>UTF-8</span>
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
			<Code2 className={styles.statusIcon} size={15} />
		</footer>
	);
}

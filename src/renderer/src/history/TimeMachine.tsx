import { useRef } from 'react';
import { Clock3, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import type { HistoryList } from '../../../shared/history';
import { useI18n } from '../i18n';
import { filename } from '../palette/commands';
import GitDiff from '../git/GitDiff';
import { useTimeMachine } from './useTimeMachine';
import styles from './TimeMachine.module.css';

/** A version's time in the UI language, to the second. */
function versionTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(document.documentElement.lang, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
}

/** The focused diff pane's scroll keys: j/k by three lines, Ctrl+D/U by half a page. */
function scrollPane(event: React.KeyboardEvent): void {
	const pane = event.target as HTMLElement;
	const key = event.key.toLowerCase();
	const offset =
		event.ctrlKey && ['d', 'u'].includes(key)
			? (pane.clientHeight / 2) * (key === 'd' ? 1 : -1)
			: !event.ctrlKey && ['j', 'k'].includes(key)
				? 66 * (key === 'j' ? 1 : -1)
				: 0;
	if (offset) {
		event.preventDefault();
		pane.scrollBy({ top: offset, behavior: 'instant' });
	}
}

/** The version a list key moves to, or undefined for a key the list does not handle. */
function versionKey(key: string, index: number, count: number): number | undefined {
	if (['ArrowDown', 'j'].includes(key)) {
		return Math.min(index + 1, count - 1);
	}
	if (['ArrowUp', 'k'].includes(key)) {
		return Math.max(index - 1, 0);
	}
	if (key === 'Home' || key === 'g') {
		return 0;
	}
	if (key === 'End' || key === 'G') {
		return count - 1;
	}
	return undefined;
}

/**
 * Time Machine (Ctrl+Shift+H): the stored versions of the current file and a diff of the
 * selected one against the editor. Ctrl+Enter restores it into the editor (unsaved).
 */
export default function TimeMachine({
	workspaceId,
	onClose
}: {
	workspaceId: string;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const list = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { data, selected, select, busy, error, current, refresh, restore } = useTimeMachine({
		workspaceId,
		listRef: list,
		onRestored: onClose
	});
	const value = current?.value;
	const focusDiff = (): void =>
		content.current?.querySelector<HTMLElement>('[data-git-scroll="after"]')?.focus();

	const panelKeyDown = (event: React.KeyboardEvent): void => {
		if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
			return;
		}
		if (event.ctrlKey && event.key === 'Enter') {
			event.preventDefault();
			void restore();
			return;
		}
		if (event.ctrlKey && ['h', 'l'].includes(event.key.toLowerCase())) {
			event.preventDefault();
			if (event.key.toLowerCase() === 'h') {
				list.current?.focus();
			} else {
				focusDiff();
			}
			return;
		}
		if ((event.target as HTMLElement).hasAttribute('data-git-scroll')) {
			scrollPane(event);
		}
	};

	const listKeyDown = (event: React.KeyboardEvent): void => {
		if (
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			event.nativeEvent.isComposing ||
			!data
		) {
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			focusDiff();
			return;
		}
		const index = data.versions.findIndex((version) => version.id === selected);
		const next = versionKey(event.key, index, data.versions.length);
		if (next === undefined) {
			return;
		}
		event.preventDefault();
		if (!busy && data.versions[next]) {
			select(data.versions[next].id);
		}
	};

	return (
		<section className={styles.panel} ref={content} aria-busy={!!busy} onKeyDown={panelKeyDown}>
			<header className={styles.toolbar}>
				<div>
					<Clock3 size={18} />
					<strong>{data ? filename(data.path) : t('Recent edits')}</strong>
					{data && <span>{t('{count} versions', { count: data.versions.length })}</span>}
				</div>
				<button
					onClick={() => void refresh()}
					disabled={!!busy}
					aria-label={t('Refresh Time Machine')}
				>
					<RefreshCw size={15} />
					{t('Refresh')}
				</button>
				<button
					className={styles.restore}
					onClick={() => void restore()}
					disabled={!!busy || !value || value.identical}
				>
					<RotateCcw size={15} />
					{t('Restore to editor')}
					<kbd>Ctrl+Enter</kbd>
				</button>
			</header>
			<div className={styles.reassurance}>
				<ShieldCheck size={15} />
				{t('Your current edits are kept before restoring. Save when ready.')}
			</div>
			{(error || current?.error) && (
				<p role="alert" className={styles.error}>
					{t(error || current?.error || '')}
				</p>
			)}
			<div className={styles.body}>
				<div
					className={styles.timeline}
					role="listbox"
					aria-label={t('Edit history')}
					tabIndex={0}
					aria-activedescendant={selected ? `history-${selected}` : undefined}
					ref={list}
					onKeyDown={listKeyDown}
				>
					{data && (
						<Versions
							data={data}
							selected={selected}
							onSelect={(id) => {
								if (!busy) {
									select(id);
								}
								list.current?.focus();
							}}
						/>
					)}
					{busy === 'list' && !data && <p role="status">{t('Loading history…')}</p>}
				</div>
				<div className={styles.preview}>
					{value && !busy ? (
						<>
							{value.identical && (
								<div className={styles.same}>
									{t('This version matches your current edits.')}
								</div>
							)}
							<GitDiff
								key={value.version.id}
								workspaceId={workspaceId}
								path={value.path}
								diff={value.diff}
								label={t('Time Machine diff')}
								beforeLabel={versionTime(value.version.timestamp)}
								afterLabel={t('Current edits')}
							/>
						</>
					) : (
						<div className={styles.empty} role="status">
							<Clock3 size={36} />
							<p>
								{error || current?.error
									? t('Your history is still here. Refresh to try again.')
									: busy === 'list' || (selected && !current)
										? t('Loading history…')
										: t(
												'Select a version to compare it with your current edits.'
											)}
							</p>
						</div>
					)}
				</div>
			</div>
			<footer>
				{t(
					'j/k Versions · Enter Preview · Ctrl+H/L History / Diff · n/N Changes · Ctrl+Enter Restore · Esc Close'
				)}
			</footer>
		</section>
	);
}

/** The versions in the timeline, newest first. */
function Versions({
	data,
	selected,
	onSelect
}: {
	data: HistoryList;
	selected: string;
	onSelect: (id: string) => void;
}): React.JSX.Element[] {
	const t = useI18n();
	return data.versions.map((version, index) => (
		<div
			key={version.id}
			id={`history-${version.id}`}
			role="option"
			aria-selected={version.id === selected}
			data-history-version={version.id}
			className={styles.version}
			onClick={() => onSelect(version.id)}
		>
			<span className={styles.dot} />
			<div>
				<strong>
					{t(
						version.kind === 'draft'
							? 'Unsaved draft'
							: version.kind === 'restored'
								? 'Restored edit'
								: 'Saved content'
					)}
				</strong>
				<time dateTime={new Date(version.timestamp).toISOString()}>
					{versionTime(version.timestamp)}
				</time>
				<small>
					#{data.versions.length - index} · {t('{count} lines', { count: version.lines })}{' '}
					· {(version.bytes / 1024).toFixed(1)} KB
				</small>
			</div>
		</div>
	));
}

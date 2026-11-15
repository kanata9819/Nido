// The parts of the workspace search panel around its fields: the option toggles, the
// replacement actions and the status footer.
import type { RefObject } from 'react';
import { useI18n } from '../i18n';
import type { SearchOptions } from '../../../shared/search';
import styles from '../assets/WorkspaceSearch.module.css';

type OptionKey = 'caseSensitive' | 'regex' | 'wholeWord';

const optionButtons = [
	['caseSensitive', 'Match case', 'Alt+C'],
	['wholeWord', 'Whole word', 'Alt+W'],
	['regex', 'Regular expression', 'Alt+R']
] as const;

/** The match options and the button that shows the replacement field. */
export function SearchOptionButtons({
	options,
	replace,
	busy,
	changeOption,
	toggleReplace
}: {
	options: SearchOptions;
	replace: boolean;
	busy: boolean;
	changeOption: (key: OptionKey) => void;
	toggleReplace: () => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<div className={styles.options}>
			{optionButtons.map(([key, label, shortcut]) => (
				<button
					key={key}
					disabled={busy}
					aria-pressed={options[key]}
					onClick={() => changeOption(key)}
				>
					{t(label)} <kbd>{shortcut}</kbd>
				</button>
			))}
			<button disabled={busy} aria-pressed={replace} onClick={toggleReplace}>
				{t('Replace')}
			</button>
		</div>
	);
}

/** Preview the replacement, then apply the previewed one. */
export function ReplacementActions({
	canPreview,
	preview,
	busy,
	applyButton,
	prepare,
	apply
}: {
	canPreview: boolean;
	preview: { count: number } | undefined;
	busy: boolean;
	applyButton: RefObject<HTMLButtonElement | null>;
	prepare: () => void;
	apply: () => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<div className={styles.actions}>
			<button disabled={!canPreview} onClick={prepare}>
				{t('Preview replacement')} <kbd>Ctrl+Enter</kbd>
			</button>
			{preview && (
				<button ref={applyButton} disabled={busy || !preview.count} onClick={apply}>
					{t('Apply replacement')} <kbd>Enter</kbd>
				</button>
			)}
		</div>
	);
}

/** The result count or what is happening, what the search covers, and the keys. */
export function SearchFooter({
	notice,
	busy,
	preview,
	truncated,
	count,
	replace
}: {
	notice: string;
	busy: boolean;
	preview: { count: number; files: unknown[] } | undefined;
	truncated: boolean | undefined;
	count: number;
	replace: boolean;
}): React.JSX.Element {
	const t = useI18n();
	const status =
		notice ||
		(busy
			? t('Working…')
			: preview
				? t('{count} replacements in {files} files · Review before applying', {
						count: preview.count,
						files: preview.files.length
					})
				: truncated
					? t('Showing the first 200 matching lines.')
					: t('{count} matching lines', { count }));
	return (
		<>
			{/* The result count and what the search covers share one line. */}
			<div className={`${styles.footer} ${styles.footerRow}`}>
				<span role="status">{status}</span>
				<span className={styles.footerNote}>
					{t(
						'Saved UTF-8 files up to 1 MiB · Git ignores respected · Replacements stay unsaved'
					)}
				</span>
			</div>
			<div className={styles.footer}>
				{preview
					? t('j/k Files · Enter/l Diff · h Back · Ctrl+Enter Focus apply · Esc Back')
					: replace
						? t(
								'Esc Results/close · j/k Move · i / Search · r Replace · f Folder · Space Include · a All · Ctrl+Enter Preview'
							)
						: t(
								'Esc Results/close · j/k Move · i a / Search · r Replace · f Folder · Ctrl+Enter Preview'
							)}
			</div>
		</>
	);
}

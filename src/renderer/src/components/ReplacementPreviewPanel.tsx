import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ReplacementPreview } from '../../../shared/search';
import { useI18n } from '../i18n';
import styles from '../assets/WorkspaceSearch.module.css';
import { navigateSearchList as navigate } from './workspaceSearchNavigation';

/**
 * The preview of a workspace replacement: the files it changes, and the selected file's lines
 * before and after. h/l move between the two and scroll sideways; j/k, Ctrl+D/U and g/G scroll.
 */
export default function ReplacementPreviewPanel({
	preview,
	file,
	setFile,
	files,
	diff
}: {
	preview: ReplacementPreview;
	file: number;
	setFile: Dispatch<SetStateAction<number>>;
	files: RefObject<HTMLDivElement | null>;
	diff: RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<>
			<div
				ref={files}
				className={styles.list}
				tabIndex={0}
				role="listbox"
				aria-label={t('Replacement files')}
				aria-activedescendant={preview.files[file] ? `replace-file-${file}` : undefined}
				onKeyDown={(event) => {
					if (
						event.nativeEvent.isComposing ||
						event.keyCode === 229 ||
						navigate(event, preview.files.length, setFile)
					) {
						return;
					}
					if (event.key === 'Enter' || event.key === 'l') {
						event.preventDefault();
						diff.current?.focus();
					}
				}}
			>
				{preview.files.map((entry, index) => (
					<div
						key={entry.path}
						id={`replace-file-${index}`}
						role="option"
						aria-selected={index === file}
						className={index === file ? styles.selected : ''}
						onClick={() => setFile(index)}
					>
						<strong>{entry.path}</strong>
						<small>{t('{count} replacements', { count: entry.count })}</small>
					</div>
				))}
				{!preview.files.length && <p>{t('Replacement would not change any files.')}</p>}
			</div>
			<div
				ref={diff}
				className={styles.diff}
				tabIndex={0}
				role="region"
				aria-label={t('Replacement diff')}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) {
						return;
					}
					if (event.key === 'h' && !event.ctrlKey) {
						event.preventDefault();
						if (event.currentTarget.scrollLeft > 0) {
							event.currentTarget.scrollLeft = Math.max(
								0,
								event.currentTarget.scrollLeft - 80
							);
						} else {
							files.current?.focus();
						}
					} else if (['j', 'k', 'h', 'l', 'd', 'u', 'g', 'G'].includes(event.key)) {
						event.preventDefault();
						if (event.key === 'l') {
							event.currentTarget.scrollLeft += 80;
						} else if (event.key === 'g') {
							event.currentTarget.scrollTop = 0;
						} else if (event.key === 'G') {
							event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
						} else {
							event.currentTarget.scrollTop +=
								(['j', 'd'].includes(event.key) ? 1 : -1) *
								(event.ctrlKey ? event.currentTarget.clientHeight / 2 : 40);
						}
					}
				}}
			>
				{preview.files[file] && (
					<>
						<h3>{t('Before')}</h3>
						<pre aria-label={t('Before replacement')}>{preview.files[file].before}</pre>
						<h3>{t('After')}</h3>
						<pre aria-label={t('After replacement')}>{preview.files[file].after}</pre>
					</>
				)}
			</div>
		</>
	);
}

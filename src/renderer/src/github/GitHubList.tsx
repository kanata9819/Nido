import type { ReactNode, RefObject } from 'react';
import { handleListKey } from '../git/listKeys';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

/** A row of a GitHub list: a title line and a line of details below it. */
export interface GitHubRow {
	key: string;
	title: ReactNode;
	/** The row's name for screen readers and its tooltip. */
	label: string;
	meta?: ReactNode;
}

/**
 * The keyboard-driven list of the GitHub page (pull requests, issues, or a pull request's
 * files). j/k and the arrows move, Ctrl+D/U and Ctrl+F/B page, Enter opens, and `keys` maps
 * further single keys, such as f for the filter, to actions.
 */
export default function GitHubList({
	rows,
	label,
	busy,
	index,
	setIndex,
	listRef,
	open,
	keys = {},
	empty
}: {
	rows: GitHubRow[];
	label: string;
	busy: boolean;
	index: number;
	setIndex: (index: number) => void;
	listRef: RefObject<HTMLDivElement | null>;
	open: () => void;
	keys?: Record<string, () => void>;
	empty: string;
}): React.JSX.Element {
	return (
		<div
			className={`${gitStyles.list} ${gitStyles.historyList} ${styles.list}`}
			ref={listRef}
			role="listbox"
			aria-label={label}
			aria-busy={busy}
			tabIndex={0}
			aria-activedescendant={rows[index] ? `github-entry-${index}` : undefined}
			onKeyDown={(event) => {
				if (busy) {
					return;
				}
				if (handleListKey(event, { count: rows.length, index, setIndex, open })) {
					return;
				}
				const action =
					!event.ctrlKey && !event.altKey && !event.metaKey ? keys[event.key] : undefined;
				if (action) {
					event.preventDefault();
					action();
				}
			}}
		>
			{rows.map((row, position) => (
				<div
					key={row.key}
					id={`github-entry-${position}`}
					role="option"
					aria-selected={index === position}
					aria-label={row.label}
					title={row.label}
					className={`${gitStyles.change} ${gitStyles.historyEntry}`}
					ref={(node) => {
						if (node && index === position) {
							node.scrollIntoView({ block: 'nearest' });
						}
					}}
					onClick={() => {
						setIndex(position);
						listRef.current?.focus();
					}}
					onDoubleClick={open}
				>
					<strong className={gitStyles.commitSubject}>{row.title}</strong>
					{row.meta && <div className={gitStyles.commitMeta}>{row.meta}</div>}
				</div>
			))}
			{!rows.length && !busy && <p>{empty}</p>}
		</div>
	);
}

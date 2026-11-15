import { useI18n } from '../../i18n';
import { useRef, useState, type RefObject } from 'react';
import { Braces, Text } from 'lucide-react';
import type { Grid } from '../../grid/grid';
import styles from '../../assets/CompletionMenu.module.css';
import OverlayPresence from '../../ui/OverlayPresence';
import { virtualRows } from '../../ui/virtualRows';
import { kindIcons } from './completion/kindIcons';
import { useCompletionMenu, type Menu } from './completion/useCompletionMenu';
import { useMenuPlacement } from './completion/useMenuPlacement';

const rowHeight = 22;
// Eight rows keep the menu close to the cursor without hiding much of the buffer.
const visibleRows = 8;
const overscan = 8;

/**
 * The insert-mode completion menu, drawn by Nido instead of Neovim's own popup menu. It
 * follows Neovim's popupmenu_* redraw events and appears next to the cursor.
 */
export default function CompletionMenu({
	id,
	grid,
	input,
	fontFamily,
	onError,
	hidden
}: {
	id: string;
	grid: RefObject<Grid>;
	input: RefObject<HTMLTextAreaElement | null>;
	fontFamily: string;
	onError: (message: string) => void;
	hidden: boolean;
}): React.JSX.Element | null {
	const t = useI18n();
	const [viewport, setViewport] = useState({ top: 0, height: visibleRows * rowHeight });
	const card = useRef<HTMLDivElement>(null);
	const menu = useCompletionMenu(id, input);
	const listId = `completion-${id}`;
	// Rows are drawn virtually: only the visible rows and `overscan` rows around them exist.
	const indices = virtualRows(viewport, menu?.items.length ?? 0, rowHeight, overscan, {
		selected: menu?.selected
	});
	useMenuPlacement({
		menu,
		hidden,
		listId,
		gridRef: grid,
		inputRef: input,
		cardRef: card,
		setViewport
	});
	if (!menu?.items.length || hidden) {
		return <OverlayPresence>{null}</OverlayPresence>;
	}
	return (
		<OverlayPresence>
			<div
				ref={card}
				className={styles.card}
				style={{ fontFamily }}
				onMouseDown={(event) => event.preventDefault()}
			>
				<div className={styles.heading}>
					<Braces size={12} /> {t('Completion')}{' '}
					<span>
						{menu.items.length} {t('candidates')}
					</span>
				</div>
				<div
					id={listId}
					className={styles.list}
					role="listbox"
					aria-label={t('Code completion')}
					aria-busy={menu.pending ?? false}
					data-row-count={menu.items.length}
					onScroll={(event) => {
						const node = event.currentTarget;
						setViewport({ top: node.scrollTop, height: node.clientHeight });
					}}
				>
					<div className={styles.items} style={{ height: menu.items.length * rowHeight }}>
						{indices.map((index) => (
							<CompletionItem
								key={index}
								listId={listId}
								index={index}
								item={menu.items[index]}
								count={menu.items.length}
								selected={menu.selected === index}
								pending={menu.pending ?? false}
								select={() => {
									if (menu.pending) {
										return;
									}
									const keys = `<Cmd>lua vim.api.nvim_select_popupmenu_item(${index}, false, false, {})<CR>`;
									void window.nido
										.input(id, keys)
										.catch((error) => onError(String(error)));
									input.current?.focus();
								}}
							/>
						))}
					</div>
				</div>
				<div className={styles.footer}>
					<span>
						<kbd>↑ ↓</kbd> {t('Select')}
					</span>
					<span>
						<kbd>Tab</kbd> {t('Accept')}
					</span>
					<span>
						<kbd>Esc</kbd> {t('Close')}
					</span>
				</div>
			</div>
		</OverlayPresence>
	);
}

/** One completion item: its kind's icon, the word and its detail. */
function CompletionItem({
	listId,
	index,
	item: [word, kind, detail],
	count,
	selected,
	pending,
	select
}: {
	listId: string;
	index: number;
	item: Menu['items'][number];
	count: number;
	selected: boolean;
	pending: boolean;
	select: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const Icon = Object.hasOwn(kindIcons, kind) ? kindIcons[kind] : Text;
	return (
		<div
			id={`${listId}-${index}`}
			className={styles.item}
			role="option"
			aria-posinset={index + 1}
			aria-setsize={count}
			style={{ top: index * rowHeight }}
			aria-selected={selected}
			aria-disabled={pending}
			title={detail || word}
			onClick={select}
		>
			<span
				className={styles.kind}
				data-kind={kind}
				role="img"
				aria-label={t(kind || 'Text')}
				title={t(kind || 'Text')}
			>
				<Icon size={14} aria-hidden="true" />
			</span>
			<span className={styles.word}>{word}</span>
			<span className={styles.detail}>{detail}</span>
		</div>
	);
}

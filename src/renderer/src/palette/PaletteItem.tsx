import { memo } from 'react';
import { Command, FolderOpen, FileCode2, CircleAlert, TriangleAlert, Info } from 'lucide-react';
import { useI18n } from '../i18n';
import type { Panel, Item } from '../types';
import styles from '../assets/Palette.module.css';
import FileIcon from '../ui/FileIcon';
import { commandKeys } from './paletteShortcuts';
import { hasOptions, paletteOptionId } from './paletteRows';

/** The icon of an item in palettes that have no file to show an icon for. */
function itemIcon(panel: Exclude<Panel, null>, severity: number | undefined): React.JSX.Element {
	switch (panel) {
		case 'problems':
			switch (severity) {
				case 1:
					return <CircleAlert size={18} />;
				case 2:
					return <TriangleAlert size={18} />;
				default:
					return <Info size={18} />;
			}
		case 'workspaces':
			return <FolderOpen size={18} />;
		case 'symbols':
		case 'search':
			return <FileCode2 size={18} />;
		default:
			return <Command size={17} />;
	}
}

/** One row of a palette. */
export default memo(function PaletteItem({
	panel,
	item,
	index,
	selected
}: {
	panel: Exclude<Panel, null>;
	item: Item;
	index: number;
	selected: boolean;
}): React.JSX.Element {
	const t = useI18n();
	// Problems and symbols are listboxes; their rows are options with ids that
	// aria-activedescendant refers to. Rows are not tab stops: the list itself has focus.
	const option = hasOptions(panel);
	// Commands show their shortcuts as keys beside them; other rows show their key as is.
	const { text: detail, keys } =
		panel === 'commands'
			? commandKeys(item.detail, item.key)
			: { text: item.detail, keys: item.key ? [item.key] : [] };
	return (
		<button
			id={option ? paletteOptionId(panel, index) : undefined}
			role={option ? 'option' : undefined}
			aria-selected={option ? selected : undefined}
			tabIndex={-1}
			data-severity={item.severity}
			className={selected ? styles.selectedItem : ''}
			data-workspace-status={item.status}
			title={item.status === 'current' ? t('Current workspace · Cannot sleep') : undefined}
			ref={(node) => {
				if (node && selected) {
					node.scrollIntoView({ block: 'nearest' });
				}
			}}
			onClick={item.run}
		>
			<span className={styles.itemIcon}>
				{panel === 'files' || panel === 'buffers' ? (
					<FileIcon path={item.detail} />
				) : (
					itemIcon(panel, item.severity)
				)}
			</span>
			<span>
				<strong>{item.title}</strong>
				{detail && <small>{detail}</small>}
			</span>
			{item.status && (
				<span className={styles.workspaceStatus} data-status={item.status}>
					{item.status === 'current' ? t('Current') : t('Sleeping')}
				</span>
			)}
			{keys.length > 0 && (
				<span className={styles.itemKeys}>
					{keys.map((key) => (
						<kbd key={key}>{key}</kbd>
					))}
				</span>
			)}
		</button>
	);
});

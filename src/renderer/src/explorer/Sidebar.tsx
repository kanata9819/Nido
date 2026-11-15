import { useI18n } from '../i18n';
import { memo, useRef, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Command } from 'lucide-react';
import ExplorerCommands from './ExplorerCommands';
import FileIcon from '../ui/FileIcon';
import FolderIcon from '../ui/FolderIcon';
import DiagnosticBadges from '../ui/DiagnosticBadges';
import type { Workspace } from '../../../shared/types';
import { useExplorer } from './useExplorer';
import { explorerRowHeight as rowHeight, useExplorerViewport } from './useExplorerViewport';
import { toggle } from './sidebarToggle';
import type { getVisibleEntries } from './sidebarTree';
import { createExplorerKeyHandler } from './sidebarKeyboard';
import styles from './Sidebar.module.css';
import { gitFileKey, type Decoration } from '../git/useGitFileStatus';

/** A row of the tree. */
type VisibleEntry = ReturnType<typeof getVisibleEntries>[number];

// The file explorer beside the editor. State and loading live in useExplorer; this file draws
// the tree and handles resizing.
interface Props {
	gitFiles: Record<string, Decoration>;
	width: number;
	onResize: (width: number) => void;
	workspace: Workspace;
	active: boolean;
	currentFile: string;
	onOpen: (path: string) => void;
	onError: (message: string) => void;
}

// Hidden trees keep their DOM and local state; refresh parent props when activated.
export default memo(
	Sidebar,
	(previous, next) =>
		previous.workspace === next.workspace &&
		((!previous.active && !next.active) ||
			(previous.active === next.active &&
				previous.gitFiles === next.gitFiles &&
				previous.width === next.width &&
				previous.currentFile === next.currentFile &&
				previous.onResize === next.onResize &&
				previous.onOpen === next.onOpen &&
				previous.onError === next.onError))
);

/**
 * The explorer of one workspace: a virtual tree of the expanded folders with Git and
 * diagnostic marks, driven with Vim-style keys (see sidebarKeyboard.ts). Its width can be
 * dragged or changed with Shift+H/L.
 */
function Sidebar({
	gitFiles,
	workspace,
	active,
	currentFile,
	onOpen,
	onError,
	width,
	onResize
}: Props): React.JSX.Element {
	const t = useI18n();
	// Set after z, so zz centers the selection as in Vim.
	const centerPrefix = useRef(false);
	const {
		visible,
		expanded,
		selected,
		selectedIndex,
		reveal,
		setSelected,
		setExpanded,
		load,
		tree,
		ready,
		initialScrollTop,
		rememberScroll,
		operation,
		setOperation,
		clipboard,
		commands,
		closeOperation,
		onDone
	} = useExplorer({ workspace, active, currentFile, onError });
	const { indices, onScroll } = useExplorerViewport({
		initialScrollTop,
		selected,
		selectedIndex,
		reveal,
		visible,
		active,
		ready,
		tree,
		rememberScroll
	});
	/** The tree's keys: zz centers the selection, : opens the commands, others run one. */
	const treeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		const pending = centerPrefix.current;
		centerPrefix.current = false;
		if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
			return;
		}
		if (event.key === 'z' && !event.ctrlKey && !event.shiftKey && !event.repeat) {
			event.preventDefault();
			event.stopPropagation();
			centerPrefix.current = !pending;
			const row = pending && document.getElementById(`file-${workspace.id}-${selected}`);
			if (row) {
				centerRow(event.currentTarget, row);
			}
			return;
		}
		if (
			event.key === ':' ||
			event.key === 'ContextMenu' ||
			(event.shiftKey && event.key === 'F10')
		) {
			event.preventDefault();
			event.stopPropagation();
			setOperation({});
			return;
		}
		const key = commandKey(event);
		const command = commands.find((command) => command.key === key);
		if (command) {
			event.preventDefault();
			event.stopPropagation();
			if (!command.disabled) {
				command.run();
			}
			return;
		}
		createExplorerKeyHandler({
			visible,
			selectedIndex,
			expanded,
			setSelected,
			setExpanded,
			load,
			onOpen
		})(event);
	};
	// The marks of the workspace folder itself, shown on its header.
	const rootDecoration = gitFiles[gitFileKey(workspace.root).replace(/\/$/, '')];

	return (
		<aside
			className={styles.sidebar}
			aria-label={t('File explorer')}
			hidden={!active}
			style={{ width }}
			onKeyDownCapture={(event) => {
				if (
					(event.target as Element).closest('[data-explorer-commands]') ||
					event.nativeEvent.isComposing ||
					event.ctrlKey ||
					event.altKey ||
					event.metaKey
				) {
					return;
				}
				if (event.shiftKey && ['H', 'L'].includes(event.key)) {
					event.preventDefault();
					event.stopPropagation();
					onResize(width + (event.key === 'H' ? -20 : 20));
				}
			}}
		>
			<ResizeHandle width={width} onResize={onResize} />
			<div className={styles.sidebarHeading}>
				<span
					className={styles.gitName}
					data-status={rootDecoration?.code || undefined}
					data-diagnostic={rootDecoration?.diagnostic}
				>
					{workspace.name}
				</span>
				<button
					title={t('Explorer commands (:)')}
					aria-label={t('Explorer commands')}
					onClick={() => setOperation({})}
				>
					<Command size={14} />
				</button>
				<button
					title={t('Refresh files')}
					aria-label={t('Refresh files')}
					onClick={() => void load('')}
				>
					<RefreshCw size={14} />
				</button>
			</div>
			<div
				ref={tree}
				className={styles.tree}
				role="tree"
				data-row-count={visible.length}
				tabIndex={0}
				aria-label={t('Project files')}
				title={t(
					'j/k Select · zz Center selection · : Commands · a/A New file/folder · F2 Rename · Ctrl+C/X/V Copy/Cut/Paste · Delete'
				)}
				aria-activedescendant={
					selectedIndex >= 0 ? `file-${workspace.id}-${selected}` : undefined
				}
				aria-busy={!ready}
				onScroll={onScroll}
				onBlur={() => {
					centerPrefix.current = false;
				}}
				onKeyDown={treeKeyDown}
			>
				<div style={{ height: visible.length * rowHeight, position: 'relative' }}>
					{indices.map((index) => {
						const entry = visible[index];
						return (
							<TreeRow
								key={entry.path}
								entry={entry}
								top={index * rowHeight}
								workspace={workspace}
								selected={selected === entry.path}
								expanded={expanded}
								current={
									gitFileKey(currentFile) ===
									gitFileKey(`${workspace.root}/${entry.path}`)
								}
								decoration={gitFiles[gitFileKey(`${workspace.root}/${entry.path}`)]}
								onContextMenu={() => {
									setSelected(entry.path);
									setOperation({});
								}}
								onClick={() =>
									toggle({
										entry,
										expanded,
										setExpanded,
										setSelected,
										onOpen,
										load
									})
								}
							/>
						);
					})}
				</div>
				{!visible.length && (
					<p className={styles.emptyTree}>
						{t('No files yet.')}
						<br />
						{/* Each key stays on a line with what it does. */}
						<span className={styles.keepTogether}>
							{t('Press')} <kbd>a</kbd> {t('for a file or')}
						</span>{' '}
						<span className={styles.keepTogether}>
							<kbd>A</kbd> {t('for a folder.')}
						</span>
					</p>
				)}
			</div>
			<div className={styles.sidebarFooter}>
				<span className={styles.liveDot} />{' '}
				{clipboard
					? `${clipboard.cut ? t('Cut') : t('Copied')}: ${clipboard.name}`
					: t('File commands')}{' '}
				<kbd>:</kbd>
			</div>
			<ExplorerCommands
				visible={!!operation}
				workspaceId={workspace.id}
				request={operation?.request}
				commands={commands}
				onClose={closeOperation}
				onDone={onDone}
			/>
		</aside>
	);
}

/** Scroll the tree so `row` is in its middle. */
function centerRow(viewport: HTMLElement, row: HTMLElement): void {
	const bounds = viewport.getBoundingClientRect();
	const target = row.getBoundingClientRect();
	viewport.scrollTop += target.top + target.height / 2 - bounds.top - viewport.clientHeight / 2;
}

/** The explorer command a key runs: Ctrl+C/X/V copy, cut and paste, F2 renames, Delete deletes. */
function commandKey(event: React.KeyboardEvent): string | undefined {
	if (event.ctrlKey) {
		return ({ c: 'c', x: 'x', v: 'p' } as Record<string, string>)[event.key.toLowerCase()];
	}
	return event.key === 'F2' ? 'r' : event.key === 'Delete' ? 'd' : event.key;
}

/** The explorer's right edge: drag it, or press ←/→ on it, to change the width. */
function ResizeHandle({
	width,
	onResize
}: {
	width: number;
	onResize: (width: number) => void;
}): React.JSX.Element {
	const t = useI18n();
	// The pointer position and width when a resize drag started.
	const drag = useRef<{ x: number; width: number } | null>(null);
	return (
		<div
			className={styles.sidebarResize}
			role="separator"
			aria-label={t('Explorer width')}
			aria-orientation="vertical"
			aria-valuemin={160}
			aria-valuemax={480}
			aria-valuenow={width}
			tabIndex={0}
			title={t('Drag to resize · Shift+H / L')}
			onKeyDown={(event) => {
				if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
					event.preventDefault();
					onResize(width + (event.key === 'ArrowLeft' ? -20 : 20));
				}
			}}
			onPointerDown={(event) => {
				if (event.button !== 0) {
					return;
				}
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { x: event.clientX, width };
			}}
			onPointerMove={(event) => {
				if (drag.current) {
					onResize(drag.current.width + event.clientX - drag.current.x);
				}
			}}
			onPointerUp={(event) => {
				drag.current = null;
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
			}}
			onLostPointerCapture={() => {
				drag.current = null;
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		/>
	);
}

/** One file or folder of the tree, with its Git and diagnostic marks. */
function TreeRow({
	entry,
	top,
	workspace,
	selected,
	expanded,
	current,
	decoration,
	onContextMenu,
	onClick
}: {
	entry: VisibleEntry;
	top: number;
	workspace: Workspace;
	selected: boolean;
	expanded: Set<string>;
	/** Whether this is the file open in the editor. */
	current: boolean;
	decoration: Decoration | undefined;
	onContextMenu: () => void;
	onClick: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const open = entry.directory && expanded.has(entry.path);
	return (
		<div
			id={`file-${workspace.id}-${entry.path}`}
			role="treeitem"
			aria-level={entry.depth + 1}
			aria-posinset={entry.position}
			aria-setsize={entry.siblings}
			aria-expanded={entry.directory ? open : undefined}
			aria-selected={selected}
			data-ignored={entry.ignored || undefined}
			className={`${styles.treeItem} ${selected ? styles.treeSelected : ''} ${current ? styles.currentFile : ''}`}
			style={
				{
					'--tree-depth': entry.depth,
					position: 'absolute',
					top,
					left: 0,
					right: 0
				} as CSSProperties
			}
			onContextMenu={(event) => {
				event.preventDefault();
				onContextMenu();
			}}
			onClick={onClick}
		>
			{entry.directory ? (
				open ? (
					<ChevronDown size={13} />
				) : (
					<ChevronRight size={13} />
				)
			) : (
				<span className={styles.treeSpacer} />
			)}
			{entry.directory ? (
				<FolderIcon path={entry.path} expanded={open} />
			) : (
				<FileIcon path={entry.path} className={styles.fileIcon} />
			)}
			<span
				className={`${styles.treeName} ${styles.gitName}`}
				data-status={decoration?.code || undefined}
				data-diagnostic={decoration?.diagnostic}
			>
				{entry.name}
			</span>
			{!entry.directory && <DiagnosticBadges decoration={decoration} />}
			{!entry.directory && decoration?.code && (
				<span
					className={styles.gitBadge}
					data-status={decoration.code}
					title={t(decoration.title)}
					aria-label={t(decoration.title)}
				>
					{decoration.code}
				</span>
			)}
		</div>
	);
}

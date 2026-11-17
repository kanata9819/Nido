import { useI18n } from '../i18n';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { Workspace, SessionState } from '../../../shared/types';
import { gitFileKey, type Decoration } from '../explorer/fileDecorations';
import { filename } from '../palette/commands';
import FileIcon from '../ui/FileIcon';
import DiagnosticBadges from '../ui/DiagnosticBadges';
import styles from './FileHeader.module.css';
import decorationStyles from '../ui/FileDecoration.module.css';

// The file tabs and breadcrumb above the editor.
interface FileHeaderProps {
	workspace: Workspace;
	buffers: SessionState['buffers'];
	current: SessionState['current'];
	decorations: Record<string, Decoration>;
	focusEditor: () => void;
	restartShell: (id: string) => void;
	run: (promise: Promise<unknown>) => void;
}

/**
 * The open files as tabs (drag to reorder) with their Git and diagnostic marks, and below them
 * the current file's path. A terminal workspace shows its folder and a restart button instead.
 */
function FileHeader({
	workspace,
	buffers,
	current: currentId,
	decorations,
	focusEditor,
	restartShell,
	run
}: FileHeaderProps): React.JSX.Element {
	const t = useI18n();
	const active = workspace.id;
	const currentIndex = buffers.findIndex((buffer) => buffer.id === currentId);
	const current = buffers[currentIndex];
	// File names open more than once (index.ts in several folders) get their folder beside them.
	const nameCounts = new Map<string, number>();
	for (const buffer of buffers) {
		if (buffer.name) {
			const name = filename(buffer.name);
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
	}
	const folderHint = (name: string): string | undefined =>
		(nameCounts.get(filename(name)) ?? 0) > 1
			? name.split(/[\\/]/).slice(-2, -1)[0]
			: undefined;
	/** Close a file's tab; the button that was clicked goes away, so focus returns to the editor. */
	const closeTab = (buffer: number): void => {
		run(window.nido.closeBuffer(active, buffer));
		focusEditor();
	};
	const selectedTab = useRef<HTMLDivElement>(null);
	// The tab being dragged; a tab can only be dropped within its own workspace.
	const draggedTab = useRef<{ workspace: string; buffer: number } | null>(null);
	const [dropTarget, setDropTarget] = useState<number | null>(null);
	// Keep the selected tab scrolled into view.
	useLayoutEffect(() => {
		selectedTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [active, current?.id, currentIndex]);
	return (
		<>
			{' '}
			<div
				className={styles.fileTabs}
				role="tablist"
				aria-label={t('Files')}
				hidden={workspace.kind === 'terminal'}
			>
				{buffers.map((buffer) => {
					const decoration = decorations[gitFileKey(buffer.name)];
					return (
						<div
							key={buffer.id}
							ref={currentId === buffer.id ? selectedTab : undefined}
							className={`${styles.fileTab} ${currentId === buffer.id ? styles.activeFile : ''}`}
							data-drop-target={dropTarget === buffer.id || undefined}
							onDragOver={(event) => {
								if (draggedTab.current?.workspace !== active) {
									return;
								}
								event.preventDefault();
								event.dataTransfer.dropEffect = 'move';
								setDropTarget(
									draggedTab.current.buffer === buffer.id ? null : buffer.id
								);
							}}
							onDragLeave={(event) => {
								if (
									!event.currentTarget.contains(
										event.relatedTarget as Node | null
									)
								) {
									setDropTarget(null);
								}
							}}
							// A middle click closes the tab, as in browsers and other editors.
							onMouseDown={(event) => {
								if (event.button === 1) {
									event.preventDefault();
								}
							}}
							onAuxClick={(event) => {
								if (event.button === 1) {
									event.preventDefault();
									closeTab(buffer.id);
								}
							}}
							onDrop={(event) => {
								const dragged = draggedTab.current;
								draggedTab.current = null;
								setDropTarget(null);
								if (dragged?.workspace !== active) {
									return;
								}
								event.preventDefault();
								if (dragged.buffer !== buffer.id) {
									run(window.nido.moveBuffer(active, dragged.buffer, buffer.id));
								}
								focusEditor();
							}}
						>
							<button
								role="tab"
								aria-selected={currentId === buffer.id}
								aria-keyshortcuts="Control+Shift+PageUp Control+Shift+PageDown"
								title={`${buffer.name || t('[Untitled]')} · ${t('Drag to reorder · Ctrl+Shift+PageUp / PageDown')}`}
								draggable
								onDragStart={(event) => {
									draggedTab.current = { workspace: active, buffer: buffer.id };
									event.dataTransfer.effectAllowed = 'move';
									event.dataTransfer.setData('text/plain', buffer.name);
								}}
								onDragEnd={() => {
									draggedTab.current = null;
									setDropTarget(null);
								}}
								onClick={() => {
									run(window.nido.selectBuffer(active, buffer.id));
									focusEditor();
								}}
							>
								<FileIcon path={buffer.name} />
								<span
									className={decorationStyles.gitName}
									data-status={decoration?.code || undefined}
									data-diagnostic={decoration?.diagnostic}
								>
									{buffer.name ? filename(buffer.name) : t('[Untitled]')}
								</span>
								{buffer.name && folderHint(buffer.name) && (
									<small className={styles.tabFolder}>
										{folderHint(buffer.name)}
									</small>
								)}
								<DiagnosticBadges decoration={decoration} />
								{decoration?.code && (
									<span
										className={decorationStyles.gitBadge}
										data-status={decoration.code}
										title={t(decoration.title)}
										aria-label={t(decoration.title)}
									>
										{decoration.code}
									</span>
								)}
								<span
									className={styles.unsaved}
									aria-label={buffer.modified ? t('Unsaved') : undefined}
									style={{ visibility: buffer.modified ? 'visible' : 'hidden' }}
								/>
							</button>
							<button
								className={styles.tabClose}
								aria-label={t('Close file {name}', {
									name: buffer.name ? filename(buffer.name) : t('[Untitled]')
								})}
								onClick={() => closeTab(buffer.id)}
							>
								<X size={12} />
							</button>
						</div>
					);
				})}
			</div>
			{/* The current file's path relative to the workspace, shown as "folder / file". */}
			<div className={styles.breadcrumb}>
				<span>{workspace.name}</span>
				<ChevronRight size={13} />
				<span>
					{workspace.kind === 'terminal'
						? workspace.root
						: current?.name
							? current.name
									.replace(workspace.root, '')
									.replace(/^[\\/]/, '')
									.replaceAll('\\', ' / ')
							: t('Untitled')}
				</span>
				{workspace.kind === 'terminal' ? (
					<button
						className={styles.restartShell}
						title={t('Restart shell (Ctrl+Shift+R)')}
						onClick={() => restartShell(active)}
					>
						{t('Restart shell')} <kbd>Ctrl Shift R</kbd>
					</button>
				) : (
					<span className={styles.breadcrumbHint}>{t('SPACE for commands')}</span>
				)}
			</div>
		</>
	);
}

export default memo(FileHeader);

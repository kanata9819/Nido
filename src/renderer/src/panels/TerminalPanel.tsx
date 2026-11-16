import { useRef } from 'react';
import { useI18n } from '../i18n';
import Editor from '../editor/Editor';
import { defaultFontFamily, type EditorSettings } from '../settings/useEditorSettings';
import styles from './TerminalPanel.module.css';

/**
 * The terminal below the editor (Ctrl+@). It is an Editor showing the terminal workspace's
 * Neovim, which runs the shells: one tab per shell, of which one is shown.
 */
export default function TerminalPanel({
	id,
	active,
	blocked,
	focusTick,
	copyMode = false,
	shells,
	height,
	maximized,
	settings,
	restartShell,
	addShell,
	selectShell,
	closeShell,
	resize,
	toggleMaximized,
	onClose,
	onError
}: {
	id: string;
	active: boolean;
	blocked: boolean;
	focusTick: number;
	/** Whether the terminal is in copy mode (Ctrl+Shift+C). */
	copyMode?: boolean;
	/** The running shells by name, and the 1-based position of the shown one. */
	shells?: { names: string[]; current: number };
	height: number;
	maximized: boolean;
	settings: EditorSettings;
	restartShell: (id: string) => void;
	addShell: (id: string) => void;
	selectShell: (id: string, position: number) => void;
	closeShell: (id: string, position: number) => void;
	resize: (height: number) => void;
	toggleMaximized: () => void;
	onClose: () => void;
	onError: (message: string) => void;
}): React.JSX.Element {
	const t = useI18n();
	const { fontSize, fontWeight, lineHeight, fontFamily, smoothCursor, smoothBlink } = settings;
	const names = shells?.names ?? [];
	return (
		<section
			className={styles.terminalPanel}
			data-maximized={maximized || undefined}
			style={maximized ? undefined : { height }}
			aria-label={t('Terminal')}
			hidden={!active}
		>
			{!maximized && <ResizeHandle height={height} onResize={resize} />}
			<div className={styles.toolbar}>
				<div className={styles.tabs} role="tablist" aria-label={t('Shells')}>
					{names.map((name, index) => {
						const position = index + 1;
						const selected = position === shells?.current;
						return (
							<div key={position} className={styles.tab} data-selected={selected}>
								<button
									role="tab"
									aria-selected={selected}
									title={t('Ctrl+Shift+PageUp / PageDown: switch shells')}
									onClick={() => selectShell(id, position)}
								>
									{names.length > 1 && <small>{position}</small>}
									{name}
								</button>
								<button
									className={styles.closeShell}
									aria-label={t('Close shell {name}', { name })}
									title={t('Close shell (Ctrl+Shift+W)')}
									onClick={() => closeShell(id, position)}
								>
									×
								</button>
							</div>
						);
					})}
					<button
						className={styles.iconButton}
						aria-label={t('New shell')}
						title={t('New shell (Ctrl+Shift+T)')}
						onClick={() => addShell(id)}
					>
						+
					</button>
				</div>
				{copyMode ? (
					<span className={styles.copyMode} role="status">
						{t('COPY · v Select · y Copy · q Back to the shell')}
					</span>
				) : (
					<span className={styles.hint}>
						{t('Ctrl+K Editor · Ctrl+Shift+C Copy mode')}
					</span>
				)}
				<button
					className={styles.iconButton}
					aria-label={t('Restart shell')}
					title={t('Restart shell (Ctrl+Shift+R)')}
					onClick={() => restartShell(id)}
				>
					↻
				</button>
				<button
					className={styles.iconButton}
					aria-label={maximized ? t('Restore terminal size') : t('Maximize terminal')}
					aria-pressed={maximized}
					title={
						maximized
							? t('Restore size (Ctrl+Shift+Enter)')
							: t('Maximize (Ctrl+Shift+Enter)')
					}
					onClick={toggleMaximized}
				>
					{maximized ? '▾' : '▴'}
				</button>
				<button
					className={styles.iconButton}
					aria-label={t('Hide terminal')}
					title={t('Hide terminal (Ctrl+@)')}
					onClick={onClose}
				>
					×
				</button>
			</div>
			<Editor
				theme={settings.theme}
				id={id}
				terminal
				active={active}
				fontSize={fontSize}
				fontWeight={fontWeight}
				lineHeight={lineHeight}
				animations={false}
				smoothCursor={smoothCursor}
				smoothBlink={smoothBlink}
				blocked={blocked}
				focusTick={focusTick}
				fontFamily={fontFamily.trim() || defaultFontFamily}
				onError={onError}
			/>
		</section>
	);
}

/** The panel's top edge: drag it, or press ↑/↓ on it, to change the height. */
function ResizeHandle({
	height,
	onResize
}: {
	height: number;
	onResize: (height: number) => void;
}): React.JSX.Element {
	const t = useI18n();
	// The pointer position and height when a resize drag started.
	const drag = useRef<{ y: number; height: number } | null>(null);
	const stop = (): void => {
		drag.current = null;
	};
	return (
		<div
			className={styles.resize}
			role="separator"
			aria-label={t('Terminal height')}
			aria-orientation="horizontal"
			aria-valuemin={120}
			aria-valuenow={height}
			tabIndex={0}
			title={t('Drag to resize · ↑ / ↓')}
			onKeyDown={(event) => {
				if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
					event.preventDefault();
					onResize(height + (event.key === 'ArrowUp' ? 20 : -20));
				}
			}}
			onPointerDown={(event) => {
				if (event.button !== 0) {
					return;
				}
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { y: event.clientY, height };
			}}
			onPointerMove={(event) => {
				if (drag.current) {
					onResize(drag.current.height + drag.current.y - event.clientY);
				}
			}}
			onPointerUp={(event) => {
				stop();
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
			}}
			onLostPointerCapture={stop}
			onPointerCancel={stop}
		/>
	);
}

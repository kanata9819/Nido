import { useI18n } from '../i18n';
import type { DebugAction, DebugState, DebugVariable } from '../../../shared/types';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import styles from '../assets/DebugPanel.module.css';

type Action = (value: DebugAction, target?: number) => void;

const navigationKeys = ['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const variableSelector = '[data-debug-variable]';

function isPlain(event: KeyboardEvent): boolean {
	return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function isHalfPage(event: KeyboardEvent): boolean {
	return (
		event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		['d', 'u'].includes(event.key.toLowerCase())
	);
}

/** Ctrl+D/U moves half a page through the variables, or scrolls the console. */
function moveHalfPage(event: KeyboardEvent, variableList: HTMLElement | null): void {
	const target = event.target as HTMLElement;
	const direction = event.key.toLowerCase() === 'd' ? 1 : -1;
	const row = target.closest<HTMLElement>(variableSelector);
	if (row && variableList) {
		event.preventDefault();
		event.stopPropagation();
		const rows = Array.from(variableList.querySelectorAll<HTMLElement>(variableSelector));
		const step = Math.max(
			1,
			Math.floor(variableList.clientHeight / row.getBoundingClientRect().height / 2)
		);
		rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + direction * step))]?.focus();
	} else if (target.tagName === 'PRE') {
		event.preventDefault();
		event.stopPropagation();
		target.scrollTop += (direction * target.clientHeight) / 2;
	}
}

/**
 * j/k move between variables. l expands a variable or enters its first child; h collapses it
 * or returns to its parent. Expanding and collapsing are only possible while paused.
 */
function adjacentVariable(
	key: string,
	variables: DebugVariable[],
	index: number,
	paused: boolean,
	action: Action
): DebugVariable {
	const value = variables[index];
	if (['j', 'ArrowDown'].includes(key)) {
		return variables[index + 1] || value;
	}
	if (['k', 'ArrowUp'].includes(key)) {
		return variables[index - 1] || value;
	}
	if (['l', 'ArrowRight'].includes(key)) {
		if (value.expandable && !value.expanded && paused) {
			action('variable', value.id);
		} else if (value.expanded && variables[index + 1]?.parent === value.id) {
			return variables[index + 1];
		}
		return value;
	}
	if (value.expanded && paused) {
		action('variable', value.id);
		return value;
	}
	return variables.find((item) => item.id === value.parent) || value;
}

/** h/j/k/l and the arrow keys cycle through the enabled buttons outside the variable list. */
function focusAdjacentButton(event: KeyboardEvent, panel: HTMLElement | null): void {
	const buttons = Array.from(
		panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []
	);
	const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
	const direction = ['h', 'k', 'ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
	event.preventDefault();
	buttons[(index + direction + buttons.length) % buttons.length]?.focus();
}

export default function DebugPanel({
	blocked = false,
	state,
	action,
	focusTick,
	onClose
}: {
	blocked?: boolean;
	state?: DebugState;
	focusTick: number;
	onClose: () => void;
	action: Action;
}): React.JSX.Element {
	const t = useI18n();
	const panel = useRef<HTMLElement>(null);
	const variableList = useRef<HTMLDivElement>(null);
	const closePrefix = useRef(false);
	const focused = useRef(false);
	const awaitingVariables = useRef(false);
	const [selected, setSelected] = useState<number>();
	useFocusRestoration(panel, focused, awaitingVariables, focusTick, state?.variables);
	const paused = state?.status === 'paused';
	const variables = state?.variables || [];
	const selectedId = variables.some((value) => value.id === selected)
		? selected
		: variables[0]?.id;

	/** Space then d closes the panel, as it does elsewhere in Nido. */
	const handleClosePrefix = (event: KeyboardEvent): boolean => {
		const plain = isPlain(event);
		if (plain && event.key === ' ') {
			event.preventDefault();
			closePrefix.current = true;
			return true;
		}
		const closing = closePrefix.current && plain && event.key === 'd';
		closePrefix.current = false;
		if (closing) {
			event.preventDefault();
			onClose();
		}
		return closing;
	};

	const moveInVariables = (event: KeyboardEvent, row: HTMLElement): void => {
		const index = variables.findIndex(
			(value) => value.id === Number(row.dataset.debugVariable)
		);
		if (!variables[index]) {
			return;
		}
		event.preventDefault();
		const next = adjacentVariable(event.key, variables, index, paused, action);
		panel.current?.querySelector<HTMLElement>(`[data-debug-variable="${next.id}"]`)?.focus();
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.nativeEvent.isComposing || handleClosePrefix(event)) {
			return;
		}
		if (isHalfPage(event)) {
			moveHalfPage(event, variableList.current);
			return;
		}
		const target = event.target as HTMLElement;
		// The console keeps its native text navigation.
		if (target.tagName === 'PRE') {
			return;
		}
		if (event.ctrlKey || event.altKey || event.metaKey || !navigationKeys.includes(event.key)) {
			return;
		}
		const row = target.closest<HTMLElement>(variableSelector);
		if (row) {
			moveInVariables(event, row);
		} else {
			focusAdjacentButton(event, panel.current);
		}
	};

	return (
		<section
			ref={panel}
			inert={blocked}
			tabIndex={-1}
			className={styles.debugPanel}
			data-debug-panel
			aria-label={t('Debugger')}
			onFocusCapture={() => {
				focused.current = true;
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					// Removing a focused variable row can blur without an outside focus target.
					if (event.relatedTarget) {
						focused.current = false;
						awaitingVariables.current = false;
					}
					closePrefix.current = false;
				}
			}}
			onKeyDown={handleKeyDown}
		>
			<DebugToolbar state={state} action={action} onClose={onClose} />
			{state?.status === 'select' && (
				<div>
					{t('Choose an executable:')}{' '}
					{state.targets.map((target, i) => (
						<button
							data-debug-target
							key={target.path}
							onClick={() => {
								panel.current?.focus();
								action('launch', i + 1);
							}}
						>
							{target.name}
						</button>
					))}
				</div>
			)}
			{state?.location && <div className={styles.debugLocation}>{state.location}</div>}
			<div className={styles.debugDetails}>
				{state?.kind !== 'run' && (
					<div className={styles.debugVariables} aria-label={t('Debug variables')}>
						<div className={styles.debugHeading}>
							<strong>{t('Variables')}</strong>
							<small>
								{t(
									'Ctrl+J Focus · Ctrl+K Editor · Ctrl+D/U Half page · j/k Move · h/l Expand'
								)}
							</small>
						</div>
						<div className={styles.debugColumns} aria-hidden="true">
							<span>{t('Name')}</span>
							<span>{t('Value')}</span>
							<span>{t('Type')}</span>
						</div>
						<div ref={variableList} className={styles.debugVariableScroll}>
							{[...new Set(variables.map((value) => value.scope))].map((scope) => (
								<div key={scope}>
									<div className={styles.debugScope}>{scope}</div>
									<div role="tree" aria-label={scope}>
										{variables
											.filter((value) => value.scope === scope)
											.map((value) => (
												<VariableRow
													key={value.id}
													value={value}
													selected={selectedId === value.id}
													onFocus={() => setSelected(value.id)}
													onClick={() => {
														if (paused && value.expandable) {
															action('variable', value.id);
														}
													}}
												/>
											))}
									</div>
								</div>
							))}
							{!variables.length && (
								<p>
									{paused
										? t('No local variables')
										: t('Pause at a breakpoint to inspect variables.')}
								</p>
							)}
						</div>
					</div>
				)}
				<div className={styles.debugConsole}>
					<div className={styles.debugHeading}>
						<strong>{t('Console')}</strong>
					</div>
					<pre aria-label={t('Debug output')} tabIndex={0}>
						{state?.output ||
							t('CodeLLDB · Save files, set a breakpoint and press F5.')}
						{state?.terminal && `\n${state.terminal}`}
					</pre>
				</div>
			</div>
		</section>
	);
}

/**
 * Focus the panel when asked (focusTick changes). DAP replaces variable IDs after stepping, so
 * restore focus after the old row disappears, while allowing the user to move back to the editor
 * during an update.
 */
function useFocusRestoration(
	panelRef: RefObject<HTMLElement | null>,
	focusedRef: RefObject<boolean>,
	awaitingVariablesRef: RefObject<boolean>,
	focusTick: number,
	variables: DebugVariable[] | undefined
): void {
	const lastFocusTick = useRef(0);
	useEffect(() => {
		const requested = focusTick !== lastFocusTick.current;
		lastFocusTick.current = focusTick;
		if (requested) {
			awaitingVariablesRef.current = !variables?.length;
		}
		if (
			focusTick &&
			(requested ||
				(focusedRef.current &&
					(awaitingVariablesRef.current ||
						!panelRef.current?.contains(document.activeElement)) &&
					variables?.length))
		) {
			(
				panelRef.current?.querySelector<HTMLButtonElement>('[data-debug-target]') ||
				panelRef.current?.querySelector<HTMLButtonElement>(
					'[data-debug-variable][aria-selected="true"]'
				) ||
				panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
			)?.focus();
			if (variables?.length) {
				awaitingVariablesRef.current = false;
			}
		}
	}, [panelRef, focusedRef, awaitingVariablesRef, focusTick, variables]);
}

function DebugToolbar({
	state,
	action,
	onClose
}: {
	state?: DebugState;
	action: Action;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const busy = state?.status === 'building' || state?.status === 'starting';
	const paused = state?.status === 'paused';
	return (
		<div className={styles.debugToolbar}>
			<strong>
				{state?.kind === 'run' ? t('Run') : t('Debug')} · {t(state?.status || 'idle')}
			</strong>
			<button disabled={busy || state?.status === 'running'} onClick={() => action('start')}>
				▶ {paused ? t('Continue') : t('Start')} <kbd>F5</kbd>
			</button>
			<button onClick={() => action('breakpoint')}>
				{t('● Breakpoint')} <kbd>F9</kbd>
			</button>
			<button disabled={!paused} onClick={() => action('over')}>
				{t('Step over')} <kbd>F10</kbd>
			</button>
			<button disabled={!paused} onClick={() => action('into')}>
				{t('Step into')} <kbd>F11</kbd>
			</button>
			<button disabled={!paused} onClick={() => action('out')}>
				{t('Step out')} <kbd>Shift F11</kbd>
			</button>
			<button
				disabled={state?.kind === 'run' || state?.status !== 'running'}
				onClick={() => action('pause')}
			>
				{t('Pause')}
			</button>
			<button
				disabled={!state || ['idle', 'finished', 'error'].includes(state.status)}
				onClick={() => action('stop')}
			>
				{t('Stop')} <kbd>Shift F5</kbd>
			</button>
			<button aria-label={t('Hide debugger')} onClick={onClose}>
				{t('× Close')} <kbd>Space d</kbd>
			</button>
		</div>
	);
}

function VariableRow({
	value,
	selected,
	onFocus,
	onClick
}: {
	value: DebugVariable;
	selected: boolean;
	onFocus: () => void;
	onClick: () => void;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<button
			role="treeitem"
			data-debug-variable={value.id}
			data-changed={value.changed || undefined}
			aria-level={value.depth + 1}
			aria-expanded={value.expandable ? value.expanded : undefined}
			aria-selected={selected}
			aria-label={`${value.name} = ${value.value}${value.type ? ` (${value.type})` : ''}${value.changed ? t(', changed') : ''}`}
			aria-busy={value.loading}
			tabIndex={selected ? 0 : -1}
			className={styles.debugVariable}
			onFocus={onFocus}
			onClick={onClick}
		>
			<span
				className={styles.debugName}
				style={{
					paddingLeft: value.depth * 16 + 6
				}}
				title={value.name}
			>
				<span aria-hidden="true">
					{value.expandable ? (value.expanded ? '▾' : '▸') : '·'}
				</span>{' '}
				{value.name}
			</span>
			<span className={styles.debugValue} title={value.error || value.value}>
				{value.changed && <span aria-label={t('Changed')}>● </span>}
				{value.value}
				{value.loading ? ' …' : ''}
				{value.error ? ` · ${value.error}` : ''}
			</span>
			<span className={styles.debugType} title={value.type}>
				{value.type}
			</span>
		</button>
	);
}

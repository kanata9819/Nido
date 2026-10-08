import { useI18n } from '../i18n';
import type { DebugAction, DebugState } from '../../../shared/types';
import { useEffect, useRef, useState } from 'react';
import styles from '../assets/DebugPanel.module.css';

export default function DebugPanel({
    state,
    action,
    focusTick,
    onClose
}: {
    state?: DebugState;
    focusTick: number;
    onClose: () => void;
    action: (value: DebugAction, target?: number) => void;
}): React.JSX.Element {
    const t = useI18n();
    const panel = useRef<HTMLElement>(null);
    const variableList = useRef<HTMLDivElement>(null);
    const closePrefix = useRef(false);
    const focused = useRef(false);
    const awaitingVariables = useRef(false);
    const lastFocusTick = useRef(0);
    const [selected, setSelected] = useState<number>();
    useEffect(() => {
        const requested = focusTick !== lastFocusTick.current;
        lastFocusTick.current = focusTick;
        if (requested) {
            awaitingVariables.current = !state?.variables?.length;
        }
        // DAP replaces variable IDs after stepping. Restore focus after the old row disappears,
        // while allowing the user to move back to the editor during an update.
        if (
            focusTick &&
            (requested ||
                (focused.current &&
                    (awaitingVariables.current ||
                        !panel.current?.contains(document.activeElement)) &&
                    state?.variables?.length))
        ) {
            (
                panel.current?.querySelector<HTMLButtonElement>('[data-debug-target]') ||
                panel.current?.querySelector<HTMLButtonElement>(
                    '[data-debug-variable][aria-selected="true"]'
                ) ||
                panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
            )?.focus();
            if (state?.variables?.length) {
                awaitingVariables.current = false;
            }
        }
    }, [focusTick, state?.variables]);
    const busy = state?.status === 'building' || state?.status === 'starting';
    const paused = state?.status === 'paused';
    const variables = state?.variables || [];
    const selectedId = variables.some((value) => value.id === selected)
        ? selected
        : variables[0]?.id;
    return (
        <section
            ref={panel}
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
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                    return;
                }
                const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
                if (plain && event.key === ' ') {
                    event.preventDefault();
                    closePrefix.current = true;
                    return;
                }
                const closing = closePrefix.current && plain && event.key === 'd';
                closePrefix.current = false;
                if (closing) {
                    event.preventDefault();
                    onClose();
                    return;
                }
                const key = event.key.toLowerCase();
                const halfPage = event.ctrlKey && !event.shiftKey && ['d', 'u'].includes(key);
                if (halfPage && !event.altKey && !event.metaKey) {
                    const target = event.target as HTMLElement;
                    const direction = key === 'd' ? 1 : -1;
                    const row = target.closest<HTMLElement>('[data-debug-variable]');
                    if (row && variableList.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        const rows = Array.from(
                            variableList.current.querySelectorAll<HTMLElement>(
                                '[data-debug-variable]'
                            )
                        );
                        const step = Math.max(
                            1,
                            Math.floor(
                                variableList.current.clientHeight /
                                    row.getBoundingClientRect().height /
                                    2
                            )
                        );
                        rows[
                            Math.max(
                                0,
                                Math.min(rows.length - 1, rows.indexOf(row) + direction * step)
                            )
                        ]?.focus();
                    } else if (target.tagName === 'PRE') {
                        event.preventDefault();
                        event.stopPropagation();
                        target.scrollTop += (direction * target.clientHeight) / 2;
                    }
                    return;
                }
                if ((event.target as HTMLElement).tagName === 'PRE') {
                    return;
                }
                if (
                    event.ctrlKey ||
                    event.altKey ||
                    event.metaKey ||
                    ![
                        'h',
                        'j',
                        'k',
                        'l',
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown'
                    ].includes(event.key)
                ) {
                    return;
                }
                const row = (event.target as HTMLElement).closest<HTMLElement>(
                    '[data-debug-variable]'
                );
                if (row) {
                    const index = variables.findIndex(
                        (value) => value.id === Number(row.dataset.debugVariable)
                    );
                    const value = variables[index];
                    if (!value) {
                        return;
                    }
                    event.preventDefault();
                    let next = value;
                    if (['j', 'ArrowDown'].includes(event.key)) {
                        next = variables[index + 1] || value;
                    }
                    if (['k', 'ArrowUp'].includes(event.key)) {
                        next = variables[index - 1] || value;
                    }
                    if (['l', 'ArrowRight'].includes(event.key)) {
                        if (value.expandable && !value.expanded && paused) {
                            action('variable', value.id);
                        } else if (value.expanded && variables[index + 1]?.parent === value.id) {
                            next = variables[index + 1];
                        }
                    }
                    if (['h', 'ArrowLeft'].includes(event.key)) {
                        if (value.expanded && paused) {
                            action('variable', value.id);
                        } else {
                            next = variables.find((item) => item.id === value.parent) || value;
                        }
                    }
                    panel.current
                        ?.querySelector<HTMLElement>(`[data-debug-variable="${next.id}"]`)
                        ?.focus();
                    return;
                }
                const buttons = Array.from(
                    panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ||
                        []
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const direction = ['h', 'k', 'ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
                event.preventDefault();
                buttons[(index + direction + buttons.length) % buttons.length]?.focus();
            }}
        >
            <div className={styles.debugToolbar}>
                <strong>
                    {state?.kind === 'run' ? t('Run') : t('Debug')} · {t(state?.status || 'idle')}
                </strong>
                <button
                    disabled={busy || state?.status === 'running'}
                    onClick={() => action('start')}
                >
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
                                                <button
                                                    key={value.id}
                                                    role="treeitem"
                                                    data-debug-variable={value.id}
                                                    data-changed={value.changed || undefined}
                                                    aria-level={value.depth + 1}
                                                    aria-expanded={
                                                        value.expandable
                                                            ? value.expanded
                                                            : undefined
                                                    }
                                                    aria-selected={selectedId === value.id}
                                                    aria-label={`${value.name} = ${value.value}${value.type ? ` (${value.type})` : ''}${value.changed ? t(', changed') : ''}`}
                                                    aria-busy={value.loading}
                                                    tabIndex={selectedId === value.id ? 0 : -1}
                                                    className={styles.debugVariable}
                                                    onFocus={() => setSelected(value.id)}
                                                    onClick={() => {
                                                        if (paused && value.expandable) {
                                                            action('variable', value.id);
                                                        }
                                                    }}
                                                >
                                                    <span
                                                        className={styles.debugName}
                                                        style={{
                                                            paddingLeft: value.depth * 16 + 6
                                                        }}
                                                        title={value.name}
                                                    >
                                                        <span aria-hidden="true">
                                                            {value.expandable
                                                                ? value.expanded
                                                                    ? '▾'
                                                                    : '▸'
                                                                : '·'}
                                                        </span>{' '}
                                                        {value.name}
                                                    </span>
                                                    <span
                                                        className={styles.debugValue}
                                                        title={value.error || value.value}
                                                    >
                                                        {value.changed && (
                                                            <span aria-label={t('Changed')}>
                                                                ●{' '}
                                                            </span>
                                                        )}
                                                        {value.value}
                                                        {value.loading ? ' …' : ''}
                                                        {value.error ? ` · ${value.error}` : ''}
                                                    </span>
                                                    <span
                                                        className={styles.debugType}
                                                        title={value.type}
                                                    >
                                                        {value.type}
                                                    </span>
                                                </button>
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

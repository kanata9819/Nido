import type { DebugAction, DebugState } from '../../../shared/types';
import { useEffect, useRef } from 'react';
import styles from '../assets/Nido.module.css';

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
  const panel = useRef<HTMLElement>(null);
  const closePrefix = useRef(false);
  useEffect(() => {
    if (focusTick) {
      (
        panel.current?.querySelector<HTMLButtonElement>('[data-debug-target]') ||
        panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      )?.focus();
    }
  }, [focusTick]);
  const busy = state?.status === 'building' || state?.status === 'starting';
  const paused = state?.status === 'paused';
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={styles.debugPanel}
      aria-label="Debugger"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
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
        if (
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          !['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          return;
        }
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const direction = ['h', 'k', 'ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        event.preventDefault();
        buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      }}
    >
      <div className={styles.debugToolbar}>
        <strong>Debug · {state?.status || 'idle'}</strong>
        <button disabled={busy || state?.status === 'running'} onClick={() => action('start')}>
          ▶ {paused ? 'Continue' : 'Start'} <kbd>F5</kbd>
        </button>
        <button onClick={() => action('breakpoint')}>
          ● Breakpoint <kbd>F9</kbd>
        </button>
        <button disabled={!paused} onClick={() => action('over')}>
          Step over <kbd>F10</kbd>
        </button>
        <button disabled={!paused} onClick={() => action('into')}>
          Step into <kbd>F11</kbd>
        </button>
        <button disabled={!paused} onClick={() => action('out')}>
          Step out <kbd>Shift F11</kbd>
        </button>
        <button disabled={state?.status !== 'running'} onClick={() => action('pause')}>
          Pause
        </button>
        <button
          disabled={!state || ['idle', 'finished', 'error'].includes(state.status)}
          onClick={() => action('stop')}
        >
          Stop <kbd>Shift F5</kbd>
        </button>
        <button aria-label="Hide debugger" onClick={onClose}>
          × Close <kbd>Space d</kbd>
        </button>
      </div>
      {state?.status === 'select' && (
        <div>
          Choose a binary:{' '}
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
        <div aria-label="Debug variables">
          <strong>Variables</strong>
          {state?.variables.map((value, i) => (
            <div key={`${value.name}-${i}`} title={value.type}>
              <span>{value.name}</span> = {value.value}
            </div>
          ))}
          {!state?.variables.length && (
            <p>{paused ? 'No local variables' : 'Pause at a breakpoint to inspect variables.'}</p>
          )}
        </div>
        <pre aria-label="Debug output">
          {state?.output || 'CodeLLDB · Save files, set a breakpoint and press F5.'}
          {state?.terminal && `\n${state.terminal}`}
        </pre>
      </div>
    </section>
  );
}

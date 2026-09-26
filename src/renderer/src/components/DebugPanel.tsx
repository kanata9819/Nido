import type { DebugAction, DebugState } from '../../../shared/types';
import styles from '../assets/Nido.module.css';

export default function DebugPanel({state, action}: {state?: DebugState; action: (value: DebugAction, target?: number) => void}): React.JSX.Element {
  const busy = state?.status === 'building' || state?.status === 'starting';
  const paused = state?.status === 'paused';
  return (
    <section className={styles.debugPanel} aria-label="Debugger">
      <div className={styles.debugToolbar}>
        <strong>Debug · {state?.status || 'idle'}</strong>
        <button disabled={busy || state?.status === 'running'} onClick={() => action('start')}>▶ {paused ? 'Continue' : 'Start'} <kbd>F5</kbd></button>
        <button onClick={() => action('breakpoint')}>● Breakpoint <kbd>F9</kbd></button>
        <button disabled={!paused} onClick={() => action('over')}>Step over <kbd>F10</kbd></button>
        <button disabled={!paused} onClick={() => action('into')}>Step into <kbd>F11</kbd></button>
        <button disabled={!paused} onClick={() => action('out')}>Step out <kbd>Shift F11</kbd></button>
        <button disabled={state?.status !== 'running'} onClick={() => action('pause')}>Pause</button>
        <button disabled={!state || ['idle', 'finished', 'error'].includes(state.status)} onClick={() => action('stop')}>Stop <kbd>Shift F5</kbd></button>
      </div>
      {state?.status === 'select' && <div>Choose a binary: {state.targets.map((target, i) => <button key={target.path} onClick={() => action('launch', i + 1)}>{target.name}</button>)}</div>}
      {state?.location && <div className={styles.debugLocation}>{state.location}</div>}
      <div className={styles.debugDetails}>
        <div aria-label="Debug variables">
          <strong>Variables</strong>
          {state?.variables.map((value, i) => <div key={`${value.name}-${i}`} title={value.type}><span>{value.name}</span> = {value.value}</div>)}
          {!state?.variables.length && <p>{paused ? 'No local variables' : 'Pause at a breakpoint to inspect variables.'}</p>}
        </div>
        <pre aria-label="Debug output">{state?.output || 'CodeLLDB · Save files, set a breakpoint and press F5.'}{state?.terminal && `\n${state.terminal}`}</pre>
      </div>
    </section>
  );
}

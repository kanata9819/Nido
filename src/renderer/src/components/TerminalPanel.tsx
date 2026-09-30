import Editor from '../Editor';
import { defaultFontFamily, type EditorSettings } from '../hooks/useEditorSettings';
import styles from '../assets/Nido.module.css';

export default function TerminalPanel({
    id,
    name,
    active,
    blocked,
    focusTick,
    settings,
    restartShell,
    onClose,
    onError
}: {
    id: string;
    name: string;
    active: boolean;
    blocked: boolean;
    focusTick: number;
    settings: EditorSettings;
    restartShell: (id: string) => void;
    onClose: () => void;
    onError: (message: string) => void;
}): React.JSX.Element {
    const { fontSize, fontFamily, smoothCursor, smoothBlink } = settings;
    return (
        <section className={styles.terminalPanel} aria-label="Terminal" hidden={!active}>
            <div className={styles.referencesToolbar}>
                <strong>Terminal · {name}</strong>
                <span>Ctrl+@ Toggle · Ctrl+K Editor</span>
                <button
                    className={styles.restartShell}
                    title="Restart shell (Ctrl+Shift+R)"
                    onClick={() => restartShell(id)}
                >
                    Restart shell <kbd>Ctrl Shift R</kbd>
                </button>
                <button aria-label="Hide terminal" onClick={onClose}>
                    ×
                </button>
            </div>
            <Editor
                id={id}
                terminal
                active={active}
                fontSize={fontSize}
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

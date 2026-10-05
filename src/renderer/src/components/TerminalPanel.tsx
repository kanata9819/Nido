import { useI18n } from '../i18n';
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
    const t = useI18n();
    const { fontSize, lineHeight, fontFamily, smoothCursor, smoothBlink } = settings;
    return (
        <section className={styles.terminalPanel} aria-label={t('Terminal')} hidden={!active}>
            <div className={styles.referencesToolbar}>
                <strong>{t('Terminal ·')} {name}</strong>
                <span>{t('Ctrl+@ Toggle · Ctrl+K Editor')}</span>
                <button
                    className={styles.restartShell}
                    title={t('Restart shell (Ctrl+Shift+R)')}
                    onClick={() => restartShell(id)}
                >
                    {t('Restart shell')} <kbd>Ctrl Shift R</kbd>
                </button>
                <button aria-label={t('Hide terminal')} onClick={onClose}>
                    ×
                </button>
            </div>
            <Editor
                theme={settings.theme}
                id={id}
                terminal
                active={active}
                fontSize={fontSize}
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

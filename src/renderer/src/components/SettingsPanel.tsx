import type { EditorSettings } from '../hooks/useEditorSettings';
import styles from '../assets/Nido.module.css';

export type SettingsPanelProps = Omit<EditorSettings, 'sidebarWidth' | 'resizeSidebar'>;

export default function SettingsPanel({
    sidebar,
    setSidebar,
    animations,
    setAnimations,
    smoothCursor,
    setSmoothCursor,
    smoothBlink,
    setSmoothBlink,
    scrollFollowCursor,
    setScrollFollowCursor,
    formatOnSave,
    setFormatOnSave,
    clipboardSharing,
    setClipboardSharing,
    relativeLineNumbers,
    setRelativeLineNumbers,
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize
}: SettingsPanelProps): React.JSX.Element {
    return (
        <div
            className={styles.settings}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
                    return;
                }
                const target = event.target as HTMLInputElement;
                const text = target.type === 'text';
                const next =
                    event.key === 'ArrowDown' || ((!text || event.ctrlKey) && event.key === 'j');
                const previous =
                    event.key === 'ArrowUp' || ((!text || event.ctrlKey) && event.key === 'k');
                if (next || previous) {
                    event.preventDefault();
                    const inputs = [...event.currentTarget.querySelectorAll('input')];
                    const index = inputs.indexOf(target);
                    inputs[(index + (next ? 1 : -1) + inputs.length) % inputs.length]?.focus();
                } else if (event.key === 'Enter' && target.type === 'checkbox') {
                    event.preventDefault();
                    target.click();
                }
            }}
        >
            <label>
                Editor font size{' '}
                <input
                    autoFocus
                    type="range"
                    min="8"
                    max="24"
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                />
                <span>{fontSize}px</span>
            </label>
            <label className={styles.fontFamilyField}>
                Font family
                <input
                    type="text"
                    value={fontFamily}
                    placeholder="Default editor font"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setFontFamily(event.target.value)}
                />
            </label>
            <label>
                Show file explorer{' '}
                <input
                    type="checkbox"
                    checked={sidebar}
                    onChange={(e) => setSidebar(e.target.checked)}
                />
            </label>
            <label>
                Format on save{' '}
                <input
                    type="checkbox"
                    checked={formatOnSave}
                    onChange={(event) => setFormatOnSave(event.target.checked)}
                />
            </label>
            <label>
                Share system clipboard{' '}
                <input
                    type="checkbox"
                    checked={clipboardSharing}
                    onChange={(event) => setClipboardSharing(event.target.checked)}
                />
            </label>
            <small>Sync Vim copy, cut and paste (yy / dd / p) with the system clipboard.</small>
            <label>
                Cursor follows scrolling{' '}
                <input
                    type="checkbox"
                    checked={scrollFollowCursor}
                    onChange={(event) => setScrollFollowCursor(event.target.checked)}
                />
            </label>
            <label>
                Relative line numbers{' '}
                <input
                    type="checkbox"
                    checked={relativeLineNumbers}
                    onChange={(event) => setRelativeLineNumbers(event.target.checked)}
                />
            </label>
            <small>
                Off: absolute line numbers. On: distance from the cursor, with the current line
                shown as an absolute number.
            </small>
            <label>
                UI animations{' '}
                <input
                    type="checkbox"
                    checked={animations}
                    onChange={(event) => setAnimations(event.target.checked)}
                />
            </label>
            <label>
                Smooth cursor movement{' '}
                <input
                    type="checkbox"
                    checked={smoothCursor}
                    onChange={(event) => setSmoothCursor(event.target.checked)}
                />
            </label>
            <label>
                Smooth cursor blink{' '}
                <input
                    type="checkbox"
                    checked={smoothBlink}
                    onChange={(event) => setSmoothBlink(event.target.checked)}
                />
            </label>
            <p>
                Tab / ↑ ↓ / j k: Move · ← →: Adjust · Space / Enter: Toggle · Esc: Close
                <br />
                Nido includes its own Neovim and editor settings. Personal Neovim config is not
                loaded.
            </p>
        </div>
    );
}

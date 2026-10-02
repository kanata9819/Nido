import type { TerminalShell } from '../../../shared/types';
import type { EditorSettings } from '../hooks/useEditorSettings';
import styles from '../assets/Nido.module.css';

export type SettingsPanelProps = Omit<EditorSettings, 'sidebarWidth' | 'resizeSidebar'>;

export default function SettingsPanel({
    terminalShell,
    setTerminalShell,
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
    editorConfig,
    setEditorConfig,
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    lineHeight,
    setLineHeight
}: SettingsPanelProps): React.JSX.Element {
    return (
        <div
            className={styles.settings}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.metaKey) {
                    return;
                }
                const target = event.target as HTMLInputElement | HTMLSelectElement;
                const key = event.key.toLowerCase();
                const down = event.ctrlKey && key === 'd';
                const up = event.ctrlKey && key === 'u';
                if (target.tagName === 'SELECT' && !event.ctrlKey) {
                    return;
                }
                if (
                    target.type === 'number' &&
                    !event.ctrlKey &&
                    ['ArrowUp', 'ArrowDown'].includes(event.key)
                ) {
                    return;
                }
                const text = target.type === 'text';
                const next =
                    down || event.key === 'ArrowDown' || ((!text || event.ctrlKey) && key === 'j');
                const previous =
                    up || event.key === 'ArrowUp' || ((!text || event.ctrlKey) && key === 'k');
                if (next || previous) {
                    event.preventDefault();
                    const inputs = [
                        ...event.currentTarget.querySelectorAll<
                            HTMLInputElement | HTMLSelectElement
                        >('input, select')
                    ];
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
                    type="number"
                    min="8"
                    max="24"
                    step="1"
                    defaultValue={fontSize}
                    onChange={(event) => {
                        if (event.target.value && event.target.validity.valid) {
                            setFontSize(event.target.valueAsNumber);
                        }
                    }}
                    onBlur={(event) => {
                        event.target.value = String(fontSize);
                    }}
                />
                <span>px</span>
            </label>
            <label>
                Editor line height{' '}
                <input
                    type="number"
                    min="8"
                    max="80"
                    step="1"
                    defaultValue={lineHeight}
                    onChange={(event) => {
                        if (event.target.value && event.target.validity.valid) {
                            setLineHeight(event.target.valueAsNumber);
                        }
                    }}
                    onBlur={(event) => {
                        event.target.value = String(lineHeight);
                    }}
                />
                <span>px</span>
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
            <h3>Terminal</h3>
            <label>
                Shell
                <select
                    value={terminalShell}
                    onChange={(event) => setTerminalShell(event.target.value as TerminalShell)}
                >
                    <option value="auto">Auto (PowerShell)</option>
                    <option value="pwsh">PowerShell 7 (pwsh)</option>
                    <option value="powershell.exe">Windows PowerShell</option>
                    <option value="cmd.exe">Command Prompt (cmd)</option>
                    <option value="wsl.exe">WSL</option>
                </select>
            </label>
            <small>Applies to new terminals and Restart Shell. The selection is saved.</small>
            <h3>Extensions</h3>
            <label>
                Use EditorConfig{' '}
                <input
                    type="checkbox"
                    checked={editorConfig}
                    onChange={(event) => setEditorConfig(event.target.checked)}
                />
            </label>
            <small>
                Apply the project's .editorconfig to indentation, line endings and save rules.
            </small>
            <p>
                Tab / ↑ ↓ / j k: Move · ← →: Adjust · Space / Enter: Toggle · Esc: Close
                <br />
                Nido includes its own Neovim and editor settings. Personal Neovim config is not
                loaded.
            </p>
        </div>
    );
}

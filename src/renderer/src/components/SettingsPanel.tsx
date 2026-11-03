import { useI18n } from '../i18n';
import type { UITheme } from '../../../shared/types';
import type { ActivityBarPosition, EditorSettings } from '../hooks/useEditorSettings';
import styles from '../assets/SettingsPanel.module.css';
import type { Language } from '../../../shared/i18n';
import { settingsKeyDown } from '../settingsKeyboard';
import TerminalSettings from './TerminalSettings';

export type SettingsPanelProps = Omit<EditorSettings, 'sidebarWidth' | 'resizeSidebar'>;

export default function SettingsPanel({
  historyEnabled,
  setHistoryEnabled,
  language,
  setLanguage,
  theme,
  setTheme,
  wordWrap,
  setWordWrap,
  methodSeparators,
  setMethodSeparators,
  stickyScroll,
  setStickyScroll,
  stickyScrollMaxLines,
  setStickyScrollMaxLines,
  terminalShell,
  setTerminalShell,
  sidebar,
  setSidebar,
  activityBarPosition,
  setActivityBarPosition,
  compactMode,
  setCompactMode,
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
  fontWeight,
  setFontWeight,
  fontSize,
  setFontSize,
  lineHeight,
  setLineHeight
}: SettingsPanelProps): React.JSX.Element {
  const t = useI18n();
  return (
    <div className={styles.settings} onKeyDown={settingsKeyDown}>
      <section aria-labelledby="settings-general">
        <h3 id="settings-general">{t('General and layout')}</h3>
        <label>
          {t('Language')}
          <select
            autoFocus
            value={language}
            onChange={(event) => setLanguage(event.target.value as Language)}
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <small>{t('Choose English or Japanese. The selection is saved.')}</small>
        <label>
          {t('Theme')}
          <select value={theme} onChange={(event) => setTheme(event.target.value as UITheme)}>
            <option value="dark">{t('Dark Modern')}</option>
            <option value="acrylic">{t('Dark Modern (Acrylic)')}</option>
            <option value="comfort">{t('Dark Comfort')}</option>
            <option value="neon">{t('Neon Noir')}</option>
          </select>
        </label>
        <small>
          {t(
            'Dark Modern colors with frosted surfaces or Comfort’s clearer panels, or Neon Noir’s glowing cyan-to-violet look. The selection is saved.'
          )}
        </small>
        <label>
          {t('Show file explorer')}{' '}
          <input type="checkbox" checked={sidebar} onChange={(e) => setSidebar(e.target.checked)} />
        </label>
        <label>
          {t('Activity bar position')}
          <select
            value={activityBarPosition}
            onChange={(event) => setActivityBarPosition(event.target.value as ActivityBarPosition)}
          >
            <option value="left">{t('Left edge')}</option>
            <option value="top">{t('Top of explorer')}</option>
          </select>
        </label>
        <small>{t('Place navigation icons on the left edge or above the file explorer.')}</small>
        <label>
          {t('Compact mode')}{' '}
          <input
            type="checkbox"
            checked={compactMode}
            onChange={(event) => setCompactMode(event.target.checked)}
          />
        </label>
        <small>
          {t(
            'Reduce session tabs, file tabs and the status bar. All sessions stay visible; Alt+Shift+W focuses session tabs.'
          )}
        </small>
        <label>
          {t('UI animations')}{' '}
          <input
            type="checkbox"
            checked={animations}
            onChange={(event) => setAnimations(event.target.checked)}
          />
        </label>
      </section>
      <section aria-labelledby="settings-appearance">
        <h3 id="settings-appearance">{t('Editor appearance')}</h3>
        <label className={styles.fontFamilyField}>
          {t('Font family')}
          <input
            type="text"
            value={fontFamily}
            placeholder={t('Default editor font')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setFontFamily(event.target.value)}
          />
        </label>
        <label>
          {t('Editor font size')}{' '}
          <input
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
          {t('Editor font weight')}{' '}
          <input
            type="number"
            min="100"
            max="900"
            step="50"
            defaultValue={fontWeight}
            onChange={(event) => {
              if (event.target.value && event.target.validity.valid) {
                setFontWeight(event.target.valueAsNumber);
              }
            }}
            onBlur={(event) => {
              event.target.value = String(fontWeight);
            }}
          />
        </label>
        <small>{t('350 is lighter; 400 is standard. Supported weights depend on the font.')}</small>
        <label>
          {t('Editor line height')}{' '}
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
        <label>
          {t('Relative line numbers')}{' '}
          <input
            type="checkbox"
            checked={relativeLineNumbers}
            onChange={(event) => setRelativeLineNumbers(event.target.checked)}
          />
        </label>
        <small>
          {t(
            'Off: absolute line numbers. On: distance from the cursor, with the current line shown as an absolute number.'
          )}
        </small>
        <label>
          {t('Word wrap')}{' '}
          <input
            type="checkbox"
            checked={wordWrap}
            onChange={(event) => setWordWrap(event.target.checked)}
          />
        </label>
        <small>{t('Wrap long lines at the editor width. The selection is saved.')}</small>
        <label>
          {t('Method separators')}{' '}
          <input
            type="checkbox"
            checked={methodSeparators}
            onChange={(event) => setMethodSeparators(event.target.checked)}
          />
        </label>
        <small>
          {t('Show horizontal lines above functions and methods. The selection is saved.')}
        </small>
        <label>
          {t('Sticky Scroll')}{' '}
          <input
            type="checkbox"
            checked={stickyScroll}
            onChange={(event) => setStickyScroll(event.target.checked)}
          />
        </label>
        <small>
          {t(
            'Keep enclosing scopes visible. Click to jump; Shift-hover shows the ending. Alt+Shift+S focuses the headers.'
          )}
        </small>
        <label className={styles.subsetting}>
          {t('Sticky Scroll maximum lines')}{' '}
          <input
            type="number"
            min="1"
            max="10"
            step="1"
            value={stickyScrollMaxLines}
            onChange={(event) => {
              if (event.target.value && event.target.validity.valid) {
                setStickyScrollMaxLines(event.target.valueAsNumber);
              }
            }}
          />
        </label>
      </section>
      <section aria-labelledby="settings-interaction">
        <h3 id="settings-interaction">{t('Cursor and interaction')}</h3>
        <label>
          {t('Smooth cursor movement')}{' '}
          <input
            type="checkbox"
            checked={smoothCursor}
            onChange={(event) => setSmoothCursor(event.target.checked)}
          />
        </label>
        <label>
          {t('Smooth cursor blink')}{' '}
          <input
            type="checkbox"
            checked={smoothBlink}
            onChange={(event) => setSmoothBlink(event.target.checked)}
          />
        </label>
        <label>
          {t('Cursor follows scrolling')}{' '}
          <input
            type="checkbox"
            checked={scrollFollowCursor}
            onChange={(event) => setScrollFollowCursor(event.target.checked)}
          />
        </label>
        <label>
          {t('Share system clipboard')}{' '}
          <input
            type="checkbox"
            checked={clipboardSharing}
            onChange={(event) => setClipboardSharing(event.target.checked)}
          />
        </label>
        <small>{t('Sync Vim copy, cut and paste (yy / dd / p) with the system clipboard.')}</small>
      </section>
      <section aria-labelledby="settings-saving">
        <h3 id="settings-saving">{t('Saving and history')}</h3>
        <label>
          {t('Format on save')}{' '}
          <input
            type="checkbox"
            checked={formatOnSave}
            onChange={(event) => setFormatOnSave(event.target.checked)}
          />
        </label>
        <label>
          {t('Use EditorConfig')}{' '}
          <input
            type="checkbox"
            checked={editorConfig}
            onChange={(event) => setEditorConfig(event.target.checked)}
          />
        </label>
        <small>
          {t("Apply the project's .editorconfig to indentation, line endings and save rules.")}
        </small>
        <label>
          {t('Automatic edit history')}{' '}
          <input
            type="checkbox"
            checked={historyEnabled}
            onChange={(event) => setHistoryEnabled(event.target.checked)}
          />
        </label>
        <small>
          {t(
            'Time Machine keeps recent edits on this computer, including unsaved drafts. Ctrl+Shift+H to recover.'
          )}
        </small>
      </section>
      <TerminalSettings terminalShell={terminalShell} setTerminalShell={setTerminalShell} />
      <p>
        {t('Tab / ↑ ↓ / j k: Move · ← →: Adjust · Space / Enter: Toggle · Esc: Close')}
        <br />
        {t(
          'Nido includes its own Neovim and editor settings. Personal Neovim config is not loaded.'
        )}
      </p>
    </div>
  );
}

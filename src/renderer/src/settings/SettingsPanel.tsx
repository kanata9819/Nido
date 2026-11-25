import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { EditorSettings } from './useEditorSettings';
import styles from './SettingsPanel.module.css';
import { settingsKeyDown } from './settingsKeyboard';
import TerminalSettings from './TerminalSettings';
import { Choice, Hint, NumberField, Toggle } from './fields/SettingFields';

/** Every editor setting with its setter, except the sidebar width, which is set by dragging. */
export type SettingsPanelProps = Omit<EditorSettings, 'sidebarWidth' | 'resizeSidebar'>;

/** The settings panel. Each control reads and writes one setting from useEditorSettings. */
export default function SettingsPanel(settings: SettingsPanelProps): React.JSX.Element {
	const t = useI18n();
	const version = useAppVersion();
	return (
		<div className={styles.settings} onKeyDown={settingsKeyDown}>
			<GeneralSettings {...settings} />
			<AppearanceSettings {...settings} />
			<InteractionSettings {...settings} />
			<SavingSettings {...settings} />
			<TerminalSettings
				terminalShell={settings.terminalShell}
				setTerminalShell={settings.setTerminalShell}
				fontSize={settings.fontSize}
				terminalFontSize={settings.terminalFontSize}
				setTerminalFontSize={settings.setTerminalFontSize}
			/>
			<p>
				{t('Tab / ↑ ↓ / j k: Move · ← →: Adjust · Space / Enter: Toggle · Esc: Close')}
				<br />
				{t(
					'Nido includes its own Neovim and editor settings. Personal Neovim config is not loaded.'
				)}
				{version && (
					<>
						<br />
						<span data-testid="app-version">
							{t('Nido version {version}', { version })}
						</span>
					</>
				)}
			</p>
		</div>
	);
}

/** The running version, shown at the bottom of the panel. */
function useAppVersion(): string {
	const [version, setVersion] = useState('');
	useEffect(() => {
		let active = true;
		void window.nido
			.updateState()
			.then((state) => {
				if (active) {
					setVersion(state.currentVersion);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);
	return version;
}

function GeneralSettings(s: SettingsPanelProps): React.JSX.Element {
	const t = useI18n();
	return (
		<section aria-labelledby="settings-general">
			<h3 id="settings-general">{t('General and layout')}</h3>
			<Choice
				label="Language"
				autoFocus
				value={s.language}
				translate={false}
				options={[
					['en', 'English'],
					['ja', '日本語']
				]}
				onChange={s.setLanguage}
			/>
			<Hint text="Choose English or Japanese. The selection is saved." />
			<Choice
				label="Theme"
				value={s.theme}
				options={[
					['dark', 'Dark Modern'],
					['acrylic', 'Dark Modern (Acrylic)'],
					['comfort', 'Dark Comfort'],
					['neon', 'Neon Noir']
				]}
				onChange={s.setTheme}
			/>
			<Hint text="Dark Modern colors with frosted surfaces or Comfort’s clearer panels, or Neon Noir’s glowing cyan-to-violet look. The selection is saved." />
			<Toggle label="Show file explorer" checked={s.sidebar} onChange={s.setSidebar} />
			<Choice
				label="Activity bar position"
				value={s.activityBarPosition}
				options={[
					['left', 'Left edge'],
					['top', 'Top of explorer']
				]}
				onChange={s.setActivityBarPosition}
			/>
			<Hint text="Place navigation icons on the left edge or above the file explorer." />
			<Toggle label="Compact mode" checked={s.compactMode} onChange={s.setCompactMode} />
			<Hint text="Reduce session tabs, file tabs and the status bar. All sessions stay visible; Alt+Shift+W focuses session tabs." />
			<Toggle label="UI animations" checked={s.animations} onChange={s.setAnimations} />
		</section>
	);
}

function AppearanceSettings(s: SettingsPanelProps): React.JSX.Element {
	const t = useI18n();
	return (
		<section aria-labelledby="settings-appearance">
			<h3 id="settings-appearance">{t('Editor appearance')}</h3>
			<label className={styles.fontFamilyField}>
				{t('Font family')}
				<input
					type="text"
					value={s.fontFamily}
					placeholder={t('Default editor font')}
					spellCheck={false}
					autoComplete="off"
					onChange={(event) => s.setFontFamily(event.target.value)}
				/>
			</label>
			<NumberField
				label="Editor font size"
				value={s.fontSize}
				min={8}
				max={24}
				step={0.5}
				unit="px"
				onChange={s.setFontSize}
			/>
			<NumberField
				label="Editor font weight"
				value={s.fontWeight}
				min={100}
				max={900}
				step={50}
				onChange={s.setFontWeight}
			/>
			<Hint text="350 is lighter; 400 is standard. Supported weights depend on the font." />
			<NumberField
				label="Editor line height"
				value={s.lineHeight}
				min={8}
				max={80}
				step={1}
				unit="px"
				onChange={s.setLineHeight}
			/>
			<Toggle
				label="Relative line numbers"
				checked={s.relativeLineNumbers}
				onChange={s.setRelativeLineNumbers}
			/>
			<Hint text="Off: absolute line numbers. On: distance from the cursor, with the current line shown as an absolute number." />
			<Toggle label="Word wrap" checked={s.wordWrap} onChange={s.setWordWrap} />
			<Hint text="Wrap long lines at the editor width. The selection is saved." />
			<Toggle
				label="Method separators"
				checked={s.methodSeparators}
				onChange={s.setMethodSeparators}
			/>
			<Hint text="Show horizontal lines above functions and methods. The selection is saved." />
			<Toggle label="Sticky Scroll" checked={s.stickyScroll} onChange={s.setStickyScroll} />
			<Hint text="Keep enclosing scopes visible. Click to jump; Shift-hover shows the ending. Alt+Shift+S focuses the headers." />
			<NumberField
				label="Sticky Scroll maximum lines"
				className={styles.subsetting}
				value={s.stickyScrollMaxLines}
				min={1}
				max={10}
				step={1}
				onChange={s.setStickyScrollMaxLines}
			/>
		</section>
	);
}

function InteractionSettings(s: SettingsPanelProps): React.JSX.Element {
	const t = useI18n();
	return (
		<section aria-labelledby="settings-interaction">
			<h3 id="settings-interaction">{t('Cursor and interaction')}</h3>
			<Toggle
				label="Smooth cursor movement"
				checked={s.smoothCursor}
				onChange={s.setSmoothCursor}
			/>
			<Toggle
				label="Smooth cursor blink"
				checked={s.smoothBlink}
				onChange={s.setSmoothBlink}
			/>
			<Toggle
				label="Cursor follows scrolling"
				checked={s.scrollFollowCursor}
				onChange={s.setScrollFollowCursor}
			/>
			<Toggle
				label="Share system clipboard"
				checked={s.clipboardSharing}
				onChange={s.setClipboardSharing}
			/>
			<Hint text="Sync Vim copy, cut and paste (yy / dd / p) with the system clipboard." />
		</section>
	);
}

function SavingSettings(s: SettingsPanelProps): React.JSX.Element {
	const t = useI18n();
	return (
		<section aria-labelledby="settings-saving">
			<h3 id="settings-saving">{t('Saving and history')}</h3>
			<Toggle label="Format on save" checked={s.formatOnSave} onChange={s.setFormatOnSave} />
			<Toggle
				label="Use EditorConfig"
				checked={s.editorConfig}
				onChange={s.setEditorConfig}
			/>
			<Hint text="Apply the project's .editorconfig to indentation, line endings and save rules." />
			<Toggle
				label="Automatic edit history"
				checked={s.historyEnabled}
				onChange={s.setHistoryEnabled}
			/>
			<Hint text="Time Machine keeps recent edits on this computer, including unsaved drafts. Ctrl+Shift+H to recover." />
		</section>
	);
}

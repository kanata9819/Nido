import { nativeTheme, shell, type BrowserWindow } from 'electron';
import { release } from 'node:os';
import { uiThemes, type UITheme } from '../../shared/types';
import type { Updates } from '../platform/updater';
import { availableTerminalShells } from '../platform/terminalShells';
import type { AppState } from './handlers';
import type { Handle } from './handle';
import { text } from './validation';

/** IPC handlers for the app itself: language, theme, window, updates and external links. */
export function registerAppHandlers({
	window,
	state,
	handle,
	updates
}: {
	window: BrowserWindow;
	state: AppState;
	handle: Handle;
	updates: Updates;
}): void {
	handle('availableTerminalShells', () => availableTerminalShells());
	handle('language', (value) => {
		if (value !== 'en' && value !== 'ja') {
			throw new Error('Invalid language.');
		}
		state.language = value;
	});
	handle('openDocumentation', (value) => {
		const url = new URL(text(value));
		if (!['https:', 'http:'].includes(url.protocol)) {
			throw new Error('Unsupported documentation URL.');
		}
		return shell.openExternal(url.href);
	});
	registerUpdateHandlers(handle, updates);
	registerWindowHandlers(handle, window);
}

function registerUpdateHandlers(handle: Handle, updates: Updates): void {
	handle('updateState', () => updates.snapshot());
	handle('updateAction', (action) => {
		switch (action) {
			case 'check':
				return updates.check();
			case 'download':
				return updates.download();
			case 'install':
				return updates.install();
			default:
				throw new Error('Unknown update action.');
		}
	});
}

function registerWindowHandlers(handle: Handle, window: BrowserWindow): void {
	// Apply the window background for a UI theme. The page itself is styled by the renderer.
	handle('theme', (value) => {
		if (!uiThemes.includes(value as UITheme)) {
			throw new Error('Invalid theme.');
		}
		// Native acrylic needs Windows 11 22H2; older systems keep an opaque backing.
		const nativeBackdrop =
			process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;
		const acrylic = value === 'acrylic' && nativeBackdrop;
		if (nativeBackdrop) {
			nativeTheme.themeSource = 'dark';
			window.setBackgroundMaterial(acrylic ? 'acrylic' : 'none');
		}
		window.setBackgroundColor(acrylic ? '#00000000' : value === 'neon' ? '#07080b' : '#141414');
	});
	handle('windowState', () => ({ maximized: window.isMaximized() }));
	handle('window', (action) => {
		switch (action) {
			case 'minimize':
				window.minimize();
				break;
			case 'maximize':
				if (window.isMaximized()) {
					window.unmaximize();
				} else {
					window.maximize();
				}
				break;
			case 'close':
				window.close();
				break;
			default:
				throw new Error('Unknown window action.');
		}
	});
}

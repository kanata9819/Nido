import { ipcMain, type BrowserWindow } from 'electron';

/** Registers the handler of one `nido:<name>` IPC call. */
export type Handle = (name: string, action: (...args: unknown[]) => unknown) => void;

/** A Handle that accepts calls only from the application renderer of `window`. */
export function trustedHandle(window: BrowserWindow): Handle {
	return (name, action) => {
		ipcMain.handle(`nido:${name}`, (event, ...args: unknown[]) => {
			if (
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame
			) {
				throw new Error('Untrusted sender.');
			}
			return action(...args);
		});
	};
}

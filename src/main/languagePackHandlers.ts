import { dialog, shell, type BrowserWindow } from 'electron';
import type { LanguagePackSnapshot } from '../shared/languagePacks';
import type { NidoEvent } from '../shared/types';
import type { AppState } from './handlers';
import type { LanguagePacks } from './languagePacks';
import type { Session } from './session';

export function registerLanguagePackHandlers({
	window,
	sessions,
	state,
	send,
	handle,
	languagePacks
}: {
	window: BrowserWindow;
	sessions: Map<string, Session>;
	state: AppState;
	send: (event: NidoEvent) => void;
	handle: (name: string, action: (...args: unknown[]) => unknown) => void;
	languagePacks: LanguagePacks;
}): void {
	let packUpdate: Promise<unknown> = Promise.resolve();
	const updatePacks = (action: () => Promise<void>): Promise<void> => {
		const update = packUpdate.then(async () => {
			await action();
			const config = await languagePacks.load();
			const results = await Promise.allSettled(
				[...sessions.values()].map((s) => s.reloadLanguagePacks(config))
			);
			for (const result of results) {
				if (result.status === 'rejected') {
					send({
						type: 'notification',
						id: state.active,
						title: 'Language packs',
						message: String(result.reason),
						severity: 'error'
					});
				}
			}
		});
		packUpdate = update.catch(() => {});
		return update;
	};
	handle('languagePacks', async (id): Promise<LanguagePackSnapshot> => {
		await packUpdate;
		const config = await languagePacks.load();
		const current = typeof id === 'string' ? sessions.get(id) : undefined;
		const runtime = current ? await current.languagePacks() : [];
		return {
			packs: config.packs.map((pack) => {
				const enabled = !config.disabled.includes(pack.id);
				const status = runtime.find((item) => item.id === pack.id);
				return {
					...pack,
					enabled,
					status: enabled ? (status?.status ?? 'ready') : 'disabled',
					message: status?.message
				};
			}),
			errors: config.errors
		};
	});
	handle('setLanguagePackEnabled', (id, enabled) => {
		if (typeof id !== 'string' || typeof enabled !== 'boolean') {
			throw new Error('Invalid language pack selection.');
		}
		return updatePacks(() => languagePacks.setEnabled(id, enabled));
	});
	handle('reloadLanguagePacks', () => updatePacks(async () => {}));
	handle('installLanguagePack', async () => {
		const result = await dialog.showOpenDialog(window, {
			properties: ['openFile'],
			filters: [{ name: 'Nido language pack', extensions: ['json'] }]
		});
		if (result.canceled || !result.filePaths[0]) {
			return;
		}
		await updatePacks(() => languagePacks.install(result.filePaths[0]));
	});
	handle('openLanguagePackFolder', async () => {
		const { mkdir } = await import('node:fs/promises');
		await mkdir(languagePacks.directory, { recursive: true });
		const error = await shell.openPath(languagePacks.directory);
		if (error) {
			throw new Error(error);
		}
	});
}

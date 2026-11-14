import type { AppUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';

// Auto-update through electron-updater, which downloads new releases from GitHub. Nothing is
// downloaded or installed automatically: the update button checks, downloads and installs.

/** The parts of electron-updater that Updates uses, so tests can pass a fake. */
export type UpdateBackend = Pick<
	AppUpdater,
	| 'on'
	| 'autoDownload'
	| 'autoInstallOnAppQuit'
	| 'allowPrerelease'
	| 'allowDowngrade'
	| 'checkForUpdates'
	| 'downloadUpdate'
	| 'quitAndInstall'
>;

/** How Updates reports to the rest of the app. */
interface UpdateOptions {
	currentVersion: string;
	enabled: boolean;
	/** Sends the new state to the update button. */
	publish: (state: UpdateState) => void;
	/** Shows a notification. */
	notify: (message: string, severity: 'info' | 'error') => void;
	/** Saves the workspaces and confirms unsaved changes; resolves false when the user cancels. */
	prepareToQuit: () => Promise<boolean>;
	/** Undoes prepareToQuit when installing fails, so Nido keeps running. */
	recover: () => void;
}

/**
 * The update state machine: idle → checking → current/available → downloading → downloaded
 * → installing. Only one check, download or install runs at a time.
 */
export class Updates {
	private state: UpdateState;
	private pending: Promise<UpdateState> | undefined;
	// Whether the running action was started by the user, so its result is shown as a notification.
	private manual = false;
	// Whether prepareToQuit succeeded for the running install, so a failure must undo it.
	private prepared = false;

	constructor(
		private backend: UpdateBackend,
		private options: UpdateOptions
	) {
		this.state = {
			status: options.enabled ? 'idle' : 'disabled',
			currentVersion: options.currentVersion,
			...(!options.enabled ? { message: 'Install Nido to enable updates.' } : {})
		};
		// Installation must pass Nido's save confirmation, even after an ordinary app quit.
		backend.autoDownload = false;
		backend.autoInstallOnAppQuit = false;
		backend.allowPrerelease = false;
		backend.allowDowngrade = false;
		backend.on('update-available', (info) => this.set('available', { version: info.version }));
		backend.on('update-not-available', () => this.set('current'));
		backend.on('download-progress', (progress) => {
			if (this.state.status === 'downloading') {
				this.set('downloading', { percent: Math.min(100, Math.max(0, progress.percent)) });
			}
		});
		backend.on('update-downloaded', (info) =>
			this.set('downloaded', { version: info.version, percent: 100 })
		);
		backend.on('error', (error) => {
			// Check/download promises report their errors; handle late installer errors here.
			if (!['checking', 'downloading'].includes(this.state.status)) {
				this.fail(error);
			}
		});
	}

	/** A copy of the current state. */
	snapshot(): UpdateState {
		return { ...this.state };
	}

	/** Change the status and publish it. Extra fields such as `message` are cleared unless given. */
	private set(status: UpdateState['status'], extra: Partial<UpdateState> = {}): void {
		if (!this.options.enabled) {
			return;
		}
		this.state = {
			currentVersion: this.state.currentVersion,
			version: this.state.version,
			status,
			...extra
		};
		this.options.publish(this.snapshot());
	}

	/** Enter the error state, notify when the user is waiting for the result, and recover. */
	private fail(error: unknown): void {
		if (!this.options.enabled) {
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		if (this.state.status === 'error' && this.state.message === message) {
			return;
		}
		const recover = this.prepared;
		this.prepared = false;
		this.set('error', { message });
		if (this.manual || recover) {
			this.options.notify(message, 'error');
		}
		if (recover) {
			this.options.recover();
		}
	}

	/** Run an action unless another is running; then every caller gets the running one's result. */
	private run(manual: boolean, action: () => Promise<void>): Promise<UpdateState> {
		if (this.pending) {
			return this.pending;
		}
		this.manual = manual;
		this.pending = action()
			.catch((error: unknown) => this.fail(error))
			.then(() => this.snapshot())
			.finally(() => {
				this.pending = undefined;
				this.manual = false;
			});
		return this.pending;
	}

	/** Check for a new version. Automatic checks (`manual` false) only notify about errors. */
	check(manual = true): Promise<UpdateState> {
		if (this.pending) {
			return this.pending;
		}
		if (['disabled', 'downloading', 'downloaded', 'installing'].includes(this.state.status)) {
			return Promise.resolve(this.snapshot());
		}
		return this.run(manual, async () => {
			this.set('checking', { version: undefined });
			try {
				await this.backend.checkForUpdates();
				if (this.state.status === 'checking') {
					this.set('current');
				}
				if (manual && this.state.status === 'current') {
					this.options.notify('No updates available.', 'info');
				}
			} catch (error) {
				// A new distribution repository has no release until the first installer is published.
				if (
					error &&
					typeof error === 'object' &&
					'code' in error &&
					(error.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
						(error.code === 'ERR_UPDATER_INVALID_RELEASE_FEED' &&
							error instanceof Error &&
							error.message.includes('No published versions on GitHub')))
				) {
					this.set('current', { message: 'No updates have been published yet.' });
					if (manual) {
						this.options.notify('No updates have been published yet.', 'info');
					}
					return;
				}
				throw error;
			}
		});
	}

	/** Download the available version. */
	download(): Promise<UpdateState> {
		if (this.pending) {
			return this.pending;
		}
		if (this.state.status !== 'available') {
			return Promise.resolve(this.snapshot());
		}
		return this.run(true, async () => {
			this.set('downloading', { percent: 0 });
			await this.backend.downloadUpdate();
		});
	}

	/** Quit and install the downloaded version, after Nido has saved its workspaces. */
	install(): Promise<UpdateState> {
		if (this.pending) {
			return this.pending;
		}
		if (this.state.status !== 'downloaded') {
			return Promise.resolve(this.snapshot());
		}
		return this.run(true, async () => {
			this.set('installing');
			if (!(await this.options.prepareToQuit())) {
				this.set('downloaded', { percent: 100 });
				return;
			}
			this.prepared = true;
			this.backend.quitAndInstall(true, true);
		});
	}
}

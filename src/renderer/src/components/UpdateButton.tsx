import { onNidoEvent } from '../nidoEvents';
import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, LoaderCircle, RefreshCw, type LucideIcon } from 'lucide-react';
import type { Translator } from '../../../shared/i18n';
import type { UpdateAction, UpdateState } from '../../../shared/types';
import styles from '../assets/UpdateButton.module.css';

/** What the button does in each update state, as its accessible name and tooltip. */
function updateLabel(
	t: Translator,
	status: UpdateState['status'] | undefined,
	percent = 0
): string {
	switch (status) {
		case 'available':
			return t('Download update');
		case 'downloaded':
			return t('Restart to update');
		case 'checking':
			return t('Checking for updates');
		case 'downloading':
			return t('Downloading update {percent}%', { percent: Math.floor(percent) });
		case 'installing':
			return t('Restarting to update');
		case 'current':
			return t('Nido is up to date');
		case 'error':
			return t('Retry update check');
		default:
			return t('Check for updates');
	}
}

/** Icons for update states that are not busy; others show RefreshCw. */
const statusIcons: Partial<Record<UpdateState['status'], LucideIcon>> = {
	current: Check,
	available: ArrowDownToLine
};

/**
 * The update button in the title bar. It follows the main process's update state and runs
 * the next step on click: check, download, or restart to install.
 */
export default function UpdateButton(): React.JSX.Element {
	const t = useI18n();
	const [update, setUpdate] = useState<UpdateState>();
	// Use the state pushed by the main process; the initial request only fills in until then.
	useEffect(() => {
		let active = true;
		let received = false;
		const unsubscribe = onNidoEvent((event) => {
			if (event.type === 'update') {
				received = true;
				setUpdate(event.state);
			}
		});
		void window.nido
			.updateState()
			.then((state) => {
				if (active && !received) {
					setUpdate(state);
				}
			})
			.catch((error: unknown) => {
				if (active) {
					setUpdate({ status: 'error', currentVersion: '', message: String(error) });
				}
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const status = update?.status;
	const busy = !update || ['checking', 'downloading', 'installing'].includes(update.status);
	const label = updateLabel(t, status, update?.percent);
	const Icon = busy ? LoaderCircle : ((status && statusIcons[status]) ?? RefreshCw);
	const currentVersion = update?.currentVersion
		? t('Nido version {version}', { version: update.currentVersion })
		: '';
	const action: UpdateAction =
		status === 'available' ? 'download' : status === 'downloaded' ? 'install' : 'check';
	return (
		<button
			className={styles.button}
			data-update-status={status ?? 'loading'}
			aria-label={label}
			aria-busy={busy}
			title={
				update?.message
					? t(update.message)
					: [label + (update?.version ? `   ${update.version}` : ''), currentVersion]
							.filter(Boolean)
							.join('\n')
			}
			disabled={busy || status === 'disabled'}
			onClick={() =>
				void window.nido
					.updateAction(action)
					.then(setUpdate)
					.catch((error: unknown) =>
						setUpdate({
							status: 'error',
							currentVersion: update?.currentVersion ?? '',
							message: String(error)
						})
					)
			}
		>
			<Icon size={16} className={busy ? styles.spinner : undefined} />
			{status === 'downloading' && <span>{Math.floor(update?.percent ?? 0)}%</span>}
			{status === 'downloaded' && <span>{t('Restart to update')}</span>}
			{status === 'available' && <span>{t('Update')}</span>}
		</button>
	);
}

import { useEffect, useRef } from 'react';
import { CircleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import styles from '../assets/Progress.module.css';

/** Shown in place of a sleeping workspace's editor when it could not be restarted. */
export default function WorkspaceWakeError({
	name,
	message,
	onRetry,
	onClose
}: {
	name: string;
	message: string;
	onRetry: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const retry = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// There is no editor to type into, so Enter retries straight away.
		retry.current?.focus();
	}, []);
	return (
		<div
			className={`${styles.workspaceLoading} ${styles.workspaceWakeError}`}
			role="alert"
			aria-label={t('Could not reopen {name}', { name })}
		>
			<CircleAlert size={22} aria-hidden="true" />
			<strong>{t('Could not reopen {name}', { name })}</strong>
			<p>{message}</p>
			<div>
				<button ref={retry} onClick={onRetry}>
					{t('Retry')}
				</button>
				<button onClick={onClose}>{t('Close workspace')}</button>
			</div>
		</div>
	);
}

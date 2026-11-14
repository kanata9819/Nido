import { X } from 'lucide-react';
import { useContext } from 'react';
import { LanguageContext, useI18n } from '../i18n';
import { translateMessage } from '../../../shared/i18n';
import { useNotificationDismissal } from '../hooks/useNotificationDismissal';
import OverlayPresence from './OverlayPresence';
import styles from '../assets/Nido.module.css';
import notificationStyles from '../assets/Notification.module.css';

/** The app-level error toast, for errors not shown in a panel. */
export default function ErrorToast({
	notice,
	animations,
	dismiss,
	onClose
}: {
	notice: { message: string } | undefined;
	animations: boolean;
	dismiss: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const language = useContext(LanguageContext);
	// Errors stay as long as warning and error notifications: leave time to read them.
	// Esc and the button still dismiss them at once.
	const fading = useNotificationDismissal(notice, animations, dismiss, 8000);
	return (
		<OverlayPresence>
			{notice?.message ? (
				<div
					className={`${styles.error} ${notificationStyles.dismissal}`}
					data-animations={animations}
					data-fading={fading}
					role="alert"
				>
					{/* Errors come from the main process in English; translate the known ones. */}
					<span>{translateMessage(language, notice.message)}</span>
					<button aria-label={t('Dismiss error')} onClick={onClose}>
						<X size={16} />
					</button>
				</div>
			) : null}
		</OverlayPresence>
	);
}

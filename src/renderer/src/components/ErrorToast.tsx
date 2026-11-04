import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { useNotificationDismissal } from '../hooks/useNotificationDismissal';
import OverlayPresence from './OverlayPresence';
import styles from '../assets/Nido.module.css';
import notificationStyles from '../assets/Notification.module.css';

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
  const fading = useNotificationDismissal(notice, animations, dismiss);
  return (
    <OverlayPresence>
      {notice?.message ? (
        <div
          className={`${styles.error} ${notificationStyles.dismissal}`}
          data-animations={animations}
          data-fading={fading}
          role="alert"
        >
          <span>{notice.message}</span>
          <button aria-label={t('Dismiss error')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </OverlayPresence>
  );
}

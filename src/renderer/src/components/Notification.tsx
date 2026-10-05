import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import type { NidoEvent } from '../../../shared/types';
import styles from '../assets/Notification.module.css';
import { useNotificationDismissal } from '../hooks/useNotificationDismissal';

type Notice = Extract<NidoEvent, { type: 'notification' }>;

export default function Notification({
    workspaceId,
    animations
}: {
    workspaceId: string;
    animations: boolean;
}): React.JSX.Element | null {
    const [notice, setNotice] = useState<Notice>();
    const [previousWorkspace, setPreviousWorkspace] = useState(workspaceId);
    if (workspaceId !== previousWorkspace) {
        setPreviousWorkspace(workspaceId);
        setNotice(undefined);
    }
    const dismiss = useCallback(() => setNotice(undefined), []);
    const fading = useNotificationDismissal(notice, animations, dismiss);
    useEffect(() => {
        return window.nido.onEvent((event) => {
            if (
                event.type === 'notification' &&
                (event.id === workspaceId || event.severity !== 'info')
            ) {
                setNotice(event);
            }
        });
    }, [workspaceId]);

    if (!notice) {
        return null;
    }
    const Icon = notice.severity === 'info' ? Info : CircleAlert;
    return (
        <aside
            className={`${styles.notice} ${styles.dismissal}`}
            data-severity={notice.severity}
            data-animations={animations}
            data-fading={fading}
            role={notice.severity === 'info' ? 'status' : 'alert'}
            aria-label={notice.title}
        >
            <Icon size={19} className={styles.icon} aria-hidden="true" />
            <div className={styles.content}>
                <strong>{notice.title}</strong>
                <p>{notice.message}</p>
                <small>Esc to dismiss</small>
            </div>
            <button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}>
                <X size={16} />
            </button>
        </aside>
    );
}

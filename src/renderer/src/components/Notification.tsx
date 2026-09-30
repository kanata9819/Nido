import { useEffect, useState } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import type { NidoEvent } from '../../../shared/types';
import styles from '../assets/Notification.module.css';

type Notice = Extract<NidoEvent, { type: 'notification' }>;

export default function Notification({
    workspaceId,
    animations
}: {
    workspaceId: string;
    animations: boolean;
}): React.JSX.Element | null {
    const [notice, setNotice] = useState<Notice>();
    const [fading, setFading] = useState(false);
    useEffect(() => {
        setNotice(undefined);
        return window.nido.onEvent((event) => {
            if (
                event.type === 'notification' &&
                (event.id === workspaceId || event.severity !== 'info')
            ) {
                setNotice(event);
            }
        });
    }, [workspaceId]);

    useEffect(() => {
        setFading(false);
        if (!notice) return;
        const dismiss = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setNotice(undefined);
        };
        document.addEventListener('keydown', dismiss);
        let fadeTimer: ReturnType<typeof setTimeout> | undefined;
        const timer =
            notice.severity === 'info'
                ? setTimeout(() => {
                      if (animations) {
                          setFading(true);
                          fadeTimer = setTimeout(() => setNotice(undefined), 300);
                      } else {
                          setNotice(undefined);
                      }
                  }, 2000)
                : undefined;
        return () => {
            clearTimeout(timer);
            clearTimeout(fadeTimer);
            document.removeEventListener('keydown', dismiss);
        };
    }, [notice, animations]);

    if (!notice) return null;
    const Icon = notice.severity === 'info' ? Info : CircleAlert;
    return (
        <aside
            className={styles.notice}
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

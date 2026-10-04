import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UpdateAction, UpdateState } from '../../../shared/types';
import styles from '../assets/UpdateButton.module.css';

export default function UpdateButton(): React.JSX.Element {
    const [update, setUpdate] = useState<UpdateState>();
    useEffect(() => {
        let active = true;
        let received = false;
        const unsubscribe = window.nido.onEvent((event) => {
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
    const label =
        status === 'available'
            ? 'Download update'
            : status === 'downloaded'
              ? 'Restart to update'
              : status === 'checking'
                ? 'Checking for updates'
                : status === 'downloading'
                  ? `Downloading update ${Math.floor(update?.percent ?? 0)}%`
                  : status === 'installing'
                    ? 'Restarting to update'
                    : status === 'current'
                      ? 'Nido is up to date'
                      : status === 'error'
                        ? 'Retry update check'
                        : 'Check for updates';
    const Icon = busy
        ? LoaderCircle
        : status === 'downloaded'
          ? RefreshCw
          : status === 'current'
            ? Check
            : status === 'available'
              ? ArrowDownToLine
              : RefreshCw;
    const action: UpdateAction =
        status === 'available' ? 'download' : status === 'downloaded' ? 'install' : 'check';
    return (
        <button
            className={styles.button}
            data-update-status={status ?? 'loading'}
            aria-label={label}
            aria-busy={busy}
            title={update?.message ?? `${label}${update?.version ? ` · ${update.version}` : ''}`}
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
            {status === 'downloaded' && <span>Restart to update</span>}
            {status === 'available' && <span>Update</span>}
        </button>
    );
}

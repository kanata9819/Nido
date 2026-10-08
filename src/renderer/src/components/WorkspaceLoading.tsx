import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import styles from '../assets/Progress.module.css';

export default function WorkspaceLoading(): React.JSX.Element | null {
    const t = useI18n();
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        // Fast startups should not flash a loading screen.
        const timer = setTimeout(() => setVisible(true), 200);
        return () => clearTimeout(timer);
    }, []);

    if (!visible) {
        return null;
    }
    return (
        <div
            className={styles.workspaceLoading}
            role="status"
            aria-label={t('Loading workspaces…')}
        >
            <span className={styles.progressSpinner} aria-hidden="true" />
            <span>{t('Loading workspaces…')}</span>
        </div>
    );
}

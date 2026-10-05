import { useI18n } from '../i18n';
import { X } from 'lucide-react';
import type { Item } from '../types';
import styles from '../assets/Nido.module.css';

export default function KeyboardGuide({
    commands,
    focusEditor
}: {
    commands: Item[];
    focusEditor: () => void;
}): React.JSX.Element {
    const t = useI18n();
    return (
        <div className={styles.leader} role="dialog" aria-label={t('Keyboard commands')}>
            <div className={styles.leaderTitle}>
                <kbd>SPACE</kbd>
                <span>{t('Where to?')}</span>
                <button aria-label={t('Dismiss commands')} onClick={focusEditor}>
                    <X size={14} />
                </button>
            </div>
            <div className={styles.leaderGrid}>
                {commands
                    .filter((c) =>
                        ['w', 'f', 'b', 'e', 'n', ',', 's', 'x', 'g', 'D'].includes(c.key)
                    )
                    .map((c) => (
                        <button key={c.key} onClick={c.run}>
                            <kbd>{c.key === 'D' ? 'Shift+D' : c.key}</kbd>
                            {c.title}
                        </button>
                    ))}
            </div>
            <footer>
                <span>{t('Space again for all commands')}</span>
                <span>{t('Esc to dismiss')}</span>
            </footer>
        </div>
    );
}

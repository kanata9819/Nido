import { useI18n } from '../i18n';
import { ArrowRight, FolderOpen, Leaf } from 'lucide-react';
import styles from '../assets/Nido.module.css';

export function WorkspaceWelcome({ onOpen }: { onOpen: () => void }): React.JSX.Element {
    const t = useI18n();
    return (
        <section
            className={`${styles.welcome} ${styles.workspaceWelcome}`}
            aria-label={t('Workspace welcome')}
        >
            <div className={styles.welcomeMark}>
                <Leaf size={43} strokeWidth={1.4} />
            </div>
            <h1>Nido</h1>
            <p>
                {t('A place for your code.')}
                <br />
                {t('Open a file to get started.')}
            </p>
            <button className={styles.primary} onClick={onOpen}>
                <FolderOpen size={18} /> {t('Open a file')} <kbd>Ctrl P</kbd>
            </button>
            <div className={styles.welcomeKeys}>
                <span>
                    <kbd>Space</kbd> {t('Commands')}
                </span>
                <span>
                    <kbd>i</kbd> {t('Start writing')}
                </span>
            </div>
        </section>
    );
}

export function Welcome({
    creating,
    create
}: {
    creating: boolean;
    create: () => Promise<void>;
}): React.JSX.Element {
    const t = useI18n();
    return (
        <section className={styles.welcome}>
            <div className={styles.welcomeMark}>
                <Leaf size={43} strokeWidth={1.4} />
            </div>
            <p className={styles.eyebrow}>{t('A PLACE FOR YOUR CODE')}</p>
            <h1>{t('Make yourself at home.')}</h1>
            <p>
                {t('Your projects, together.')}
                <br />
                {t('The Neovim you know. A little more room to think.')}
            </p>
            <button className={styles.primary} disabled={creating} onClick={() => void create()}>
                <FolderOpen size={18} />
                {creating ? t('Starting Neovim…') : t('Open a workspace')}
                <ArrowRight size={17} />
            </button>
            <div className={styles.welcomeKeys}>
                <span>
                    <kbd>Ctrl Shift N</kbd> {t('Open workspace')}
                </span>
                <span>
                    <kbd>Ctrl Shift P</kbd> {t('All commands')}
                </span>
            </div>
            <div className={styles.welcomeNote}>
                <span className={styles.liveDot} /> {t('Every workspace runs its own Neovim session.')}
            </div>
        </section>
    );
}

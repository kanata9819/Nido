import { ArrowRight, FolderOpen, Leaf } from 'lucide-react';
import styles from '../assets/Nido.module.css';

export function WorkspaceWelcome({ onOpen }: { onOpen: () => void }): React.JSX.Element {
    return (
        <section
            className={`${styles.welcome} ${styles.workspaceWelcome}`}
            aria-label="Workspace welcome"
        >
            <div className={styles.welcomeMark}>
                <Leaf size={43} strokeWidth={1.4} />
            </div>
            <h1>Nido</h1>
            <p>
                A place for your code.
                <br />
                Open a file to get started.
            </p>
            <button className={styles.primary} onClick={onOpen}>
                <FolderOpen size={18} /> Open a file <kbd>Ctrl P</kbd>
            </button>
            <div className={styles.welcomeKeys}>
                <span>
                    <kbd>Space</kbd> Commands
                </span>
                <span>
                    <kbd>i</kbd> Start writing
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
    return (
        <section className={styles.welcome}>
            <div className={styles.welcomeMark}>
                <Leaf size={43} strokeWidth={1.4} />
            </div>
            <p className={styles.eyebrow}>A PLACE FOR YOUR CODE</p>
            <h1>Make yourself at home.</h1>
            <p>
                Your projects, together.
                <br />
                The Neovim you know. A little more room to think.
            </p>
            <button className={styles.primary} disabled={creating} onClick={() => void create()}>
                <FolderOpen size={18} />
                {creating ? 'Starting Neovim…' : 'Open a workspace'}
                <ArrowRight size={17} />
            </button>
            <div className={styles.welcomeKeys}>
                <span>
                    <kbd>Ctrl Shift N</kbd> Open workspace
                </span>
                <span>
                    <kbd>Ctrl Shift P</kbd> All commands
                </span>
            </div>
            <div className={styles.welcomeNote}>
                <span className={styles.liveDot} /> Every workspace runs its own Neovim session.
            </div>
        </section>
    );
}

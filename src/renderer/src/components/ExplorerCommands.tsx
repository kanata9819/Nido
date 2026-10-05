import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Command, X } from 'lucide-react';
import type { FileAction } from '../../../shared/types';
import styles from '../assets/Nido.module.css';

export interface FileRequest {
    action: FileAction;
    path: string;
    value: string;
    title: string;
}

export default function ExplorerCommands({
    workspaceId,
    request,
    commands,
    onClose,
    onDone
}: {
    workspaceId: string;
    request?: FileRequest;
    commands: { title: string; key: string; disabled?: boolean; run: () => void }[];
    onClose: () => void;
    onDone: (path: string) => void;
}): React.JSX.Element {
    const t = useI18n();
    const dialog = useRef<HTMLDialogElement>(null);
    const field = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState(request?.value || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [previousRequest, setPreviousRequest] = useState(request);
    if (request !== previousRequest) {
        setPreviousRequest(request);
        setValue(request?.value || '');
        setError('');
    }
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal();
        return () => element.close();
    }, []);
    useEffect(() => {
        field.current?.focus();
        field.current?.select();
    }, [request]);
    const submit = async (): Promise<void> => {
        if (!request || busy) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            const creating =
                request.action === 'createFile' || request.action === 'createDirectory';
            const path = creating ? value : request.path;
            const renaming = request.title === 'Rename';
            if (renaming && /[\\/]/.test(value)) {
                throw new Error(t('Enter a name. Use Move to… to change folders.'));
            }
            const target = renaming ? request.path.replace(/[^\\/]+$/, '') + value : value;
            await window.nido.fileAction(
                workspaceId,
                request.action,
                path,
                creating ? undefined : target
            );
            onDone(
                request.action === 'delete'
                    ? request.path.replace(/[\\/]?[^\\/]+$/, '')
                    : creating
                      ? path
                      : target
            );
            onClose();
        } catch (e) {
            setError(String(e));
            setBusy(false);
            field.current?.focus();
        }
    };
    return (
        <dialog
            ref={dialog}
            className={`${styles.palette} ${styles.explorerDialog}`}
            data-explorer-commands
            aria-label={t('Explorer commands')}
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) {
                    onClose();
                }
            }}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) {
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    if (!busy) {
                        onClose();
                    }
                }
                if (!request && !event.ctrlKey && !event.altKey && !event.metaKey) {
                    const command = commands.find(
                        (item) => item.key === event.key && !item.disabled
                    );
                    if (command) {
                        event.preventDefault();
                        command.run();
                    }
                    if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
                        event.preventDefault();
                        const buttons = [
                            ...dialog.current!.querySelectorAll<HTMLButtonElement>(
                                '[data-file-command]:not(:disabled)'
                            )
                        ];
                        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                        buttons[
                            (index +
                                (['j', 'ArrowDown'].includes(event.key) ? 1 : -1) +
                                buttons.length) %
                                buttons.length
                        ]?.focus();
                    }
                }
            }}
        >
            <div className={styles.paletteHeading}>
                <Command size={17} />
                <span>{t(request?.title || 'Explorer commands')}</span>
                <button aria-label={t('Close explorer commands')} disabled={busy} onClick={onClose}>
                    <X size={17} />
                </button>
            </div>
            {request ? (
                <form
                    className={styles.explorerForm}
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {request.action === 'delete' ? (
                        <p>
                            {t('Move {path} to the recycle bin?', { path: request.path })}
                        </p>
                    ) : (
                        <>
                            <label htmlFor="explorer-path">
                                {request.title === 'Rename' ? t('Name') : t('Workspace-relative path')}
                            </label>
                            <input
                                id="explorer-path"
                                ref={field}
                                className={styles.paletteInput}
                                value={value}
                                disabled={busy}
                                required
                                autoFocus
                                onChange={(event) => setValue(event.target.value)}
                            />
                        </>
                    )}
                    {error && <p role="alert">{error}</p>}
                    <div className={styles.explorerActions}>
                        <button type="button" disabled={busy} onClick={onClose}>
                            {t('Cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            autoFocus={request.action === 'delete'}
                        >
                            {busy
                                ? t('Working…')
                                : request.action === 'delete'
                                  ? t('Move to recycle bin')
                                  : t('Apply')}
                        </button>
                    </div>
                </form>
            ) : (
                <div className={styles.paletteItems}>
                    {commands.map((item) => (
                        <button
                            key={item.title}
                            data-file-command
                            disabled={item.disabled}
                            onClick={item.run}
                        >
                            <span>
                                <strong>{t(item.title)}</strong>
                            </span>
                            <kbd>{item.key}</kbd>
                        </button>
                    ))}
                </div>
            )}
        </dialog>
    );
}

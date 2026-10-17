import { useCallback, useEffect, useRef, useState } from 'react';
import type { LanguagePackSnapshot } from '../../../shared/languagePacks';
import { useI18n } from '../i18n';
import styles from '../assets/ExtensionsPage.module.css';

const statusLabels = {
    disabled: 'Disabled',
    ready: 'Available',
    starting: 'Starting',
    running: 'Running',
    missing: 'Setup required',
    error: 'Failed to start'
} as const;

export default function LanguagePacksPanel({
    workspaceId,
    query
}: {
    workspaceId?: string;
    query: string;
}): React.JSX.Element {
    const t = useI18n();
    const [snapshot, setSnapshot] = useState<LanguagePackSnapshot>({ packs: [], errors: [] });
    const [error, setError] = useState('');
    const [actionError, setActionError] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const alive = useRef(false);
    const changing = useRef(false);
    const sequence = useRef({ value: 0 });
    const refresh = useCallback(async () => {
        const request = ++sequence.current.value;
        try {
            const next = await window.nido.languagePacks(workspaceId);
            if (alive.current && request === sequence.current.value && next) {
                setSnapshot(next);
                setError('');
            }
        } catch (error) {
            if (alive.current && request === sequence.current.value) {
                setError(String(error));
            }
        } finally {
            if (alive.current && request === sequence.current.value) {
                setLoading(false);
            }
        }
    }, [workspaceId]);
    useEffect(() => {
        alive.current = true;
        const initial = setTimeout(() => void refresh(), 0);
        const requests = sequence.current;
        const timer = setInterval(() => {
            if (!changing.current) {
                void refresh();
            }
        }, 2000);
        return () => {
            alive.current = false;
            requests.value++;
            clearTimeout(initial);
            clearInterval(timer);
        };
    }, [refresh]);
    const perform = async (action: () => Promise<void>): Promise<void> => {
        if (changing.current) {
            return;
        }
        changing.current = true;
        setActionError('');
        setBusy(true);
        try {
            await action();
            await refresh();
        } catch (error) {
            await refresh();
            if (alive.current) {
                setActionError(String(error));
            }
        } finally {
            changing.current = false;
            if (alive.current) {
                setBusy(false);
            }
        }
    };
    const needle = query.trim().toLocaleLowerCase();
    const packs = snapshot.packs.filter((pack) =>
        [
            pack.title,
            pack.description,
            t(pack.description),
            pack.id,
            ...pack.filetypes,
            ...(pack.languages ?? []).flatMap((language) => [
                language.title,
                language.extensions,
                language.keywords ?? ''
            ])
        ].some((value) => value.toLocaleLowerCase().includes(needle))
    );
    return (
        <section className={styles.category} aria-label={t('Language packs')}>
            <div className={styles.packActions}>
                <button
                    disabled={busy}
                    onClick={() => void perform(() => window.nido.installLanguagePack())}
                >
                    {t('Install language pack')}
                </button>
                <button
                    disabled={busy}
                    onClick={() => void perform(() => window.nido.reloadLanguagePacks())}
                >
                    {t('Reload language packs')}
                </button>
                <button
                    disabled={busy}
                    onClick={() => void perform(() => window.nido.openLanguagePackFolder())}
                >
                    {t('Open pack folder')}
                </button>
            </div>
            <p className={styles.categoryDescription}>
                {t(
                    workspaceId
                        ? 'Language tool status for the current workspace.'
                        : 'Open a workspace to check language tools.'
                )}
            </p>
            {error && (
                <p role="alert" className={styles.packError}>
                    {error}
                </p>
            )}
            {actionError && (
                <p role="alert" className={styles.packError}>
                    {actionError}
                </p>
            )}
            {snapshot.errors.map((message) => (
                <p key={message} role="alert" className={styles.packError}>
                    {message}
                </p>
            ))}
            {loading && <p role="status">{t('Loading language packs…')}</p>}
            <ul className={styles.grid}>
                {packs.map((pack) => (
                    <li key={pack.id} className={styles.card} data-pack={pack.id}>
                        <div className={styles.cardHeading}>
                            <div>
                                <h4>{pack.title}</h4>
                                <code className={styles.extensions}>
                                    {pack.version} · {pack.filetypes.join(' · ')}
                                </code>
                            </div>
                            <span className={styles.neutralBadge}>
                                {t(pack.bundled ? 'Built-in' : 'Installed')}
                            </span>
                        </div>
                        <p>{t(pack.description)}</p>
                        <div className={styles.packControls}>
                            <span role="status" className={styles.badge} data-status={pack.status}>
                                {t(
                                    !workspaceId && pack.enabled
                                        ? 'Enabled'
                                        : statusLabels[pack.status]
                                )}
                            </span>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={pack.enabled}
                                    disabled={busy}
                                    aria-label={t('Enable {name}', { name: pack.title })}
                                    onChange={(event) => {
                                        const enabled = event.currentTarget.checked;
                                        const next: LanguagePackSnapshot = {
                                            ...snapshot,
                                            packs: snapshot.packs.map((item) =>
                                                item.id === pack.id
                                                    ? {
                                                          ...item,
                                                          enabled,
                                                          status: enabled ? 'ready' : 'disabled'
                                                      }
                                                    : item
                                            )
                                        };
                                        setSnapshot(next);
                                        void perform(() =>
                                            window.nido.setLanguagePackEnabled(pack.id, enabled)
                                        );
                                    }}
                                />
                                {t('Enabled')}
                            </label>
                        </div>
                        {pack.message && <p className={styles.packError}>{t(pack.message)}</p>}
                        {pack.setup && (
                            <code className={styles.installCommand}>{t(pack.setup)}</code>
                        )}
                    </li>
                ))}
            </ul>
            {!loading && !packs.length && (
                <p className={styles.empty}>{t('No language packs match your search.')}</p>
            )}
        </section>
    );
}

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
  query,
  category
}: {
  workspaceId?: string;
  query: string;
  category: 'language' | 'other';
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
    if (!alive.current) {
      return;
    }
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
    let pending = false;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (cancelled || pending || changing.current || document.hidden) {
        return;
      }
      pending = true;
      try {
        await refresh();
      } finally {
        pending = false;
      }
    };
    const resume = (): void => {
      void poll();
    };
    const initial = setTimeout(resume, 0);
    const requests = sequence.current;
    const timer = setInterval(resume, 2000);
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      alive.current = false;
      requests.value++;
      clearTimeout(initial);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (changing.current || !alive.current) {
      return;
    }
    changing.current = true;
    // A status read started before this mutation must not undo the optimistic toggle.
    sequence.current.value++;
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
  const packs = snapshot.packs.filter(
    (pack) =>
      (pack.category ?? 'language') === category &&
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
    <section
      className={styles.category}
      aria-label={t(category === 'language' ? 'Language packs' : 'Other extensions')}
    >
      <div className={styles.packActions}>
        <button
          disabled={busy}
          onClick={() => void perform(() => window.nido.installLanguagePack())}
        >
          {t(category === 'language' ? 'Install language pack' : 'Install extension')}
        </button>
        <button
          disabled={busy}
          onClick={() => void perform(() => window.nido.reloadLanguagePacks())}
        >
          {t(category === 'language' ? 'Reload language packs' : 'Reload extensions')}
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
          category === 'language'
            ? workspaceId
              ? 'Language tool status for the current workspace.'
              : 'Open a workspace to check language tools.'
            : workspaceId
              ? 'Extension status for the current workspace.'
              : 'Open a workspace to check extension status.'
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
      {loading && (
        <p role="status">
          {t(category === 'language' ? 'Loading language packs…' : 'Loading extensions…')}
        </p>
      )}
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
                {t(!workspaceId && pack.enabled ? 'Enabled' : statusLabels[pack.status])}
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
                    void perform(() => window.nido.setLanguagePackEnabled(pack.id, enabled));
                  }}
                />
                {t('Enabled')}
              </label>
            </div>
            {pack.message && <p className={styles.packError}>{t(pack.message)}</p>}
            {pack.setup && <code className={styles.installCommand}>{t(pack.setup)}</code>}
          </li>
        ))}
      </ul>
      {!loading && !packs.length && (
        <p className={styles.empty}>
          {t(
            category === 'language'
              ? 'No language packs match your search.'
              : query.trim()
                ? 'No extensions match your search.'
                : 'No other extensions installed.'
          )}
        </p>
      )}
    </section>
  );
}

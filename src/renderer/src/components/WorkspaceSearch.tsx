import { useEffect, useMemo, useState } from 'react';
import type { SearchResults } from '../../../shared/types';
import { useI18n } from '../i18n';
import PaletteItems from './PaletteItems';
import styles from '../assets/Palette.module.css';

export default function WorkspaceSearch({
    workspaceId,
    onClose
}: {
    workspaceId: string;
    onClose: () => void;
}): React.JSX.Element {
    const t = useI18n();
    const [query, setQuery] = useState('');
    const [selection, setSelection] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<SearchResults>({ matches: [], truncated: false });

    useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void window.nido
                .searchText(workspaceId, query)
                .then((result) => {
                    if (!cancelled) {
                        setResult(result);
                    }
                })
                .catch((error) => {
                    if (!cancelled) {
                        setError(String(error));
                    }
                })
                .finally(() => {
                    if (!cancelled) {
                        setLoading(false);
                    }
                });
        }, 100);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            void window.nido.cancelFindFiles(workspaceId).catch(() => {});
        };
    }, [workspaceId, query]);

    const items = useMemo(
        () =>
            result.matches.map((match) => ({
                key: '',
                title: `${match.path}:${match.line}:${match.column}`,
                detail: match.text,
                run: () => {
                    void window.nido
                        .openFile(workspaceId, match.path, match.line, match.column)
                        .then(onClose)
                        .catch((error) => setError(String(error)));
                }
            })),
        [result.matches, workspaceId, onClose]
    );

    return (
        <>
            <PaletteItems
                panel="search"
                filtered={items}
                selection={selection}
                query={query}
                loading={loading}
                setQuery={(query) => {
                    setLoading(!!query);
                    setError('');
                    setResult({ matches: [], truncated: false });
                    setQuery(query);
                }}
                setSelection={setSelection}
            />
            {error && (
                <p className={styles.noResults} role="alert">
                    {error}
                </p>
            )}
            <div className={styles.paletteFooter} role="status">
                {result.truncated
                    ? t('Showing the first 200 matching lines.')
                    : t('{count} matching lines', { count: result.matches.length })}
            </div>
            <div className={styles.paletteFooter}>
                {t('Saved UTF-8 files up to 1 MiB · Case-sensitive · Git ignores respected')}
            </div>
        </>
    );
}

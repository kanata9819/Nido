import { useEffect, useState } from 'react';
import type { DocumentSymbolList } from '../../../shared/types';
import { filterItems } from '../commands';
import { useFocusGuard } from '../hooks/useFocusGuard';
import { useI18n } from '../i18n';
import PaletteItems from './PaletteItems';

export default function SymbolPalette({
    workspaceId,
    buffer,
    symbols,
    focusEditor
}: {
    workspaceId: string;
    buffer: number;
    symbols?: DocumentSymbolList;
    focusEditor: () => void;
}): React.JSX.Element {
    const t = useI18n();
    const [version, setVersion] = useState<number>();
    const [query, setQuery] = useState('');
    const [selection, setSelection] = useState(0);
    const [failure, setFailure] = useState('');
    const captureFocus = useFocusGuard(workspaceId);
    useEffect(() => {
        let cancelled = false;
        void window.nido
            .findSymbols(workspaceId)
            .then((version) => {
                if (!cancelled) {
                    setVersion(version);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    setFailure(String(error));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [workspaceId]);

    // A reopened palette must wait for its own response, even in the same buffer.
    const current =
        version !== undefined && symbols?.buffer === buffer && symbols.version >= version
            ? symbols
            : undefined;
    const loading = !failure && (!current || current.loading);
    const items =
        !loading && !failure
            ? (current?.items || []).map((symbol, index) => ({
                  key: t(symbol.kind),
                  title: symbol.name,
                  detail: [symbol.container, t('Line {line}', { line: symbol.line })]
                      .filter(Boolean)
                      .join(' · '),
                  run: () => {
                      const canFocus = captureFocus();
                      void window.nido
                          .openSymbol(workspaceId, index + 1, current!.version)
                          .then(() => {
                              if (canFocus()) {
                                  focusEditor();
                              }
                          })
                          .catch((error) => {
                              if (canFocus()) {
                                  setFailure(String(error));
                              }
                          });
                  }
              }))
            : [];
    return (
        <PaletteItems
            panel="symbols"
            filtered={filterItems(items, query).slice(0, 100)}
            selection={selection}
            query={query}
            loading={loading}
            message={
                failure ||
                current?.error ||
                (!query && !current?.items.length ? 'No symbols found in this file.' : '')
            }
            setQuery={setQuery}
            setSelection={setSelection}
        />
    );
}

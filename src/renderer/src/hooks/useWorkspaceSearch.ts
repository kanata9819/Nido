import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react';
import type { SearchResults } from '../../../shared/types';
import type { ReplacementPreview, SearchOptions } from '../../../shared/search';
import { useI18n } from '../i18n';

interface Options {
  workspaceId: string;
  query: string;
  options: SearchOptions;
  replacement: string;
  focus: (target: 'results' | 'files') => void;
}

interface WorkspaceSearch {
  selection: number;
  setSelection: Dispatch<SetStateAction<number>>;
  excluded: Set<number>;
  setExcluded: Dispatch<SetStateAction<Set<number>>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  locked: RefObject<boolean>;
  error: string;
  notice: string;
  result: SearchResults;
  preview: ReplacementPreview | undefined;
  setPreview: Dispatch<SetStateAction<ReplacementPreview | undefined>>;
  file: number;
  setFile: Dispatch<SetStateAction<number>>;
  failure: (value: unknown) => void;
  invalidate: () => void;
  reset: () => void;
  prepare: () => Promise<void>;
  apply: () => Promise<void>;
}

export function useWorkspaceSearch({
  workspaceId,
  query,
  options,
  replacement,
  focus
}: Options): WorkspaceSearch {
  const t = useI18n();
  const [selection, setSelection] = useState(0);
  const [excluded, setExcluded] = useState(new Set<number>());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<SearchResults>({ matches: [], truncated: false });
  const [preview, setPreview] = useState<ReplacementPreview>();
  const [file, setFile] = useState(0);
  const request = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);

  const failure = (value: unknown): void => {
    const message = String(value).replace(
      /^Error: (?:Error invoking remote method '[^']+': Error: )?/,
      ''
    );
    setError(t(message));
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.nido
        .searchText(workspaceId, query, options)
        .then((result) => {
          if (!cancelled) {
            setResult(result);
            setExcluded(new Set());
            setSelection(0);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            failure(error);
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
    // Translation changes do not restart a search or invalidate its preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, query, options]);

  const invalidate = (): void => {
    request.current++;
    setPreview(undefined);
    setError('');
    setNotice('');
  };
  const reset = (): void => {
    setResult({ matches: [], truncated: false });
    setSelection(0);
    setLoading(!!query);
  };
  const prepare = async (): Promise<void> => {
    if (locked.current || loading || !result.token) {
      return;
    }
    const selected = result.matches.flatMap((_, index) => (excluded.has(index) ? [] : [index]));
    if (!selected.length) {
      return;
    }
    const generation = ++request.current;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await window.nido.previewReplacement(
        workspaceId,
        result.token,
        replacement,
        selected
      );
      if (!alive.current || generation !== request.current) {
        return;
      }
      setPreview(value);
      setFile(0);
      focus('files');
    } catch (error) {
      if (alive.current && generation === request.current) {
        failure(error);
      }
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  const apply = async (): Promise<void> => {
    if (locked.current || !preview?.count) {
      return;
    }
    const generation = ++request.current;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await window.nido.applyReplacement(workspaceId, preview.token);
      if (!alive.current || generation !== request.current) {
        return;
      }
      setPreview(undefined);
      setResult({ matches: [], truncated: false });
      setNotice(
        t(
          'Replaced {count} occurrences in {files} files. Unsaved edits · :wall to save all · u to undo in each file.',
          { ...value }
        )
      );
      focus('results');
    } catch (error) {
      if (alive.current && generation === request.current) {
        failure(error);
        setPreview(undefined);
        focus('results');
      }
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  };

  return {
    selection,
    setSelection,
    excluded,
    setExcluded,
    loading,
    setLoading,
    busy,
    locked,
    error,
    notice,
    result,
    preview,
    setPreview,
    file,
    setFile,
    failure,
    invalidate,
    reset,
    prepare,
    apply
  };
}

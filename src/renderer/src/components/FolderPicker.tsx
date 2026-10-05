import { useCallback, useEffect, useRef, useState } from 'react';
import { Star, X } from 'lucide-react';
import type { FavoriteWorkspace, FileEntry } from '../../../shared/types';
import styles from '../assets/Nido.module.css';

export default function FolderPicker({
    initialPath,
    favorites,
    favoriteBusy,
    onOpenFavorite,
    onRemoveFavorite,
    busy,
    onOpen
}: {
    initialPath: string;
    favorites: FavoriteWorkspace[];
    favoriteBusy: boolean;
    onOpenFavorite: (favorite: FavoriteWorkspace) => void;
    onRemoveFavorite: (favorite: FavoriteWorkspace) => void;
    busy: boolean;
    onOpen: (path: string, kind: 'editor' | 'terminal') => void;
}): React.JSX.Element {
    const [path, setPath] = useState(initialPath);
    const [kind, setKind] = useState<'editor' | 'terminal'>('editor');
    const [directory, setDirectory] = useState('');
    const [parent, setParent] = useState('');
    const [folders, setFolders] = useState<FileEntry[]>([]);
    const [selected, setSelected] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const list = useRef<HTMLDivElement>(null);
    const address = useRef<HTMLInputElement>(null);
    const request = useRef({ id: 0 });
    const choiceCount = favorites.length + folders.length;
    const [previousChoiceCount, setPreviousChoiceCount] = useState(choiceCount);
    if (choiceCount !== previousChoiceCount) {
        setPreviousChoiceCount(choiceCount);
        setSelected((value) => Math.max(0, Math.min(value, choiceCount - 1)));
    }
    const applyFolders = useCallback(
        (result: Awaited<ReturnType<typeof window.nido.browseFolders>>): void => {
            setPath(result.path);
            setDirectory(result.path);
            setParent(result.parent);
            setFolders(result.folders);
            setSelected(0);
        },
        []
    );
    async function browse(next: string): Promise<void> {
        const id = ++request.current.id;
        setLoading(true);
        setError('');
        try {
            const result = await window.nido.browseFolders(next);
            if (id !== request.current.id) {
                return;
            }
            applyFolders(result);
            requestAnimationFrame(() => {
                if (id === request.current.id) {
                    list.current?.focus();
                }
            });
        } catch (error) {
            if (id === request.current.id) {
                setError(String(error));
            }
        } finally {
            if (id === request.current.id) {
                setLoading(false);
            }
        }
    }
    useEffect(() => {
        const counter = request.current;
        const id = ++counter.id;
        void window.nido
            .browseFolders(initialPath)
            .then(
                (result) => {
                    if (id !== counter.id) {
                        return;
                    }
                    applyFolders(result);
                    requestAnimationFrame(() => {
                        if (id === counter.id) {
                            list.current?.focus();
                        }
                    });
                },
                (error) => {
                    if (id === counter.id) {
                        setError(String(error));
                    }
                }
            )
            .finally(() => {
                if (id === counter.id) {
                    setLoading(false);
                }
            });
        return () => {
            counter.id++;
        };
    }, [initialPath, applyFolders]);
    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selected]);
    return (
        <div
            className={styles.folderPicker}
            onKeyDown={(event) => {
                if (event.ctrlKey && event.key.toLowerCase() === 'l') {
                    event.preventDefault();
                    address.current?.focus();
                    address.current?.select();
                }
                if (event.ctrlKey && event.key === 'Enter' && !busy && !loading) {
                    event.preventDefault();
                    onOpen(path, kind);
                }
            }}
        >
            <input
                ref={address}
                className={`${styles.paletteInput} ${styles.folderPath}`}
                aria-label="Folder path"
                value={path}
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.ctrlKey) {
                        event.preventDefault();
                        void browse(path);
                    }
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        list.current?.focus();
                    }
                }}
            />
            <div className={styles.folderActions}>
                <label>
                    Session type{' '}
                    <select
                        aria-label="Session type"
                        value={kind}
                        disabled={busy}
                        onChange={(event) => setKind(event.target.value as 'editor' | 'terminal')}
                    >
                        <option value="editor">Editor</option>
                        <option value="terminal">Terminal</option>
                    </select>
                </label>
                <button
                    disabled={loading || busy || parent === directory}
                    onClick={() => void browse(parent)}
                >
                    ↑ Parent
                </button>
                <button
                    disabled={loading || busy || !directory}
                    onClick={() => onOpen(directory, kind)}
                >
                    {busy ? 'Opening…' : 'Open current folder'}
                </button>
            </div>
            {error && <p role="alert">{error}</p>}
            <div
                ref={list}
                role="listbox"
                aria-label="Folders"
                tabIndex={0}
                aria-busy={loading || busy}
                aria-activedescendant={
                    selected < choiceCount ? `folder-choice-${selected}` : undefined
                }
                className={styles.paletteItems}
                onKeyDown={(event) => {
                    if (
                        event.ctrlKey ||
                        event.altKey ||
                        event.metaKey ||
                        event.nativeEvent.isComposing ||
                        busy ||
                        (event.target as HTMLElement).closest('button')
                    ) {
                        return;
                    }
                    const key = event.key;
                    if (
                        ![
                            'j',
                            'k',
                            'h',
                            'l',
                            'ArrowDown',
                            'ArrowUp',
                            'ArrowLeft',
                            'ArrowRight',
                            'Enter',
                            'Backspace'
                        ].includes(key)
                    ) {
                        return;
                    }
                    event.preventDefault();
                    switch (key) {
                        case 'j':
                        case 'ArrowDown': {
                            setSelected((value) =>
                                Math.max(0, Math.min(choiceCount - 1, value + 1))
                            );
                            break;
                        }
                        case 'k':
                        case 'ArrowUp': {
                            setSelected((value) => Math.max(0, value - 1));
                            break;
                        }
                        case 'h':
                        case 'ArrowLeft':
                        case 'Backspace': {
                            if (!loading) {
                                void browse(parent);
                            }
                            break;
                        }
                        default: {
                            const favorite = favorites[selected];
                            const folder = folders[selected - favorites.length];
                            if (favorite) {
                                onOpenFavorite(favorite);
                            } else if (!loading && folder) {
                                if (key === 'Enter') {
                                    onOpen(folder.path, kind);
                                } else {
                                    void browse(folder.path);
                                }
                            }
                            break;
                        }
                    }
                }}
            >
                {favorites.length > 0 && <p className={styles.folderSection}>Favorites</p>}
                {favorites.map((favorite, index) => (
                    <div
                        key={`${favorite.root}:${favorite.kind}`}
                        id={`folder-choice-${index}`}
                        role="option"
                        aria-label={`Favorite ${favorite.name} (${favorite.kind})`}
                        aria-selected={index === selected}
                        className={`${styles.folderChoice} ${styles.favoriteChoice} ${index === selected ? styles.selectedItem : ''}`}
                        onClick={() => {
                            if (!busy) {
                                onOpenFavorite(favorite);
                            }
                        }}
                        title={favorite.root}
                    >
                        <Star size={16} className={styles.favoriteStar} />
                        <span>
                            <strong>{favorite.name}</strong>
                            <small>
                                {favorite.root} · {favorite.kind}
                            </small>
                        </span>
                        <button
                            aria-label={`Remove favorite ${favorite.name} (${favorite.kind})`}
                            title="Remove favorite"
                            disabled={favoriteBusy || busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRemoveFavorite(favorite);
                                list.current?.focus();
                            }}
                        >
                            <X size={14} />
                        </button>
                    </div>
                ))}
                {favorites.length > 0 && <p className={styles.folderSection}>Browse folders</p>}
                {loading ? (
                    <p>Loading folders…</p>
                ) : (
                    folders.map((folder, index) => (
                        <div
                            key={folder.path}
                            id={`folder-choice-${index + favorites.length}`}
                            role="option"
                            aria-selected={index + favorites.length === selected}
                            className={`${styles.folderChoice} ${index + favorites.length === selected ? styles.selectedItem : ''}`}
                            onClick={() => {
                                setSelected(index + favorites.length);
                                list.current?.focus();
                            }}
                            onDoubleClick={() => void browse(folder.path)}
                        >
                            ▸ {folder.name}
                        </div>
                    ))
                )}
                {!loading && !folders.length && (
                    <p>No subfolders. Open this folder with Ctrl+Enter.</p>
                )}
            </div>
            <p className={styles.folderActions}>
                j/k Select · h/l Browse · Enter Open selected · Ctrl+Enter Open current · Ctrl+L
                Path · Esc Cancel
            </p>
        </div>
    );
}

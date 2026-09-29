import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Braces } from 'lucide-react';
import type { Grid } from '../grid';
import styles from '../assets/CompletionMenu.module.css';

interface Menu {
    items: [string, string, string, string][];
    selected: number;
    row: number;
    column: number;
}

export default function CompletionMenu({
    id,
    grid,
    input,
    fontFamily,
    onError,
    hidden
}: {
    id: string;
    grid: RefObject<Grid>;
    input: RefObject<HTMLTextAreaElement | null>;
    fontFamily: string;
    onError: (message: string) => void;
    hidden: boolean;
}): React.JSX.Element | null {
    const [menu, setMenu] = useState<Menu>();
    const card = useRef<HTMLDivElement>(null);
    const listId = `completion-${id}`;
    useEffect(
        () =>
            window.nido.onEvent((event) => {
                if (event.id !== id || event.type !== 'redraw') return;
                for (const [name, ...calls] of event.events) {
                    for (const args of calls) {
                        if (name === 'popupmenu_show')
                            setMenu({
                                items: args[0] as Menu['items'],
                                selected: Number(args[1]),
                                row: Number(args[2]),
                                column: Number(args[3])
                            });
                        if (name === 'popupmenu_select')
                            setMenu(
                                (current) => current && { ...current, selected: Number(args[0]) }
                            );
                        if (name === 'popupmenu_hide') setMenu(undefined);
                    }
                }
            }),
        [id]
    );
    useLayoutEffect(() => {
        const element = card.current;
        const anchor = input.current;
        if (!menu || !element || !anchor || hidden) return;
        const host = element.parentElement!;
        const position = (): void => {
            const { cellWidth, cellHeight, scrollFraction } = grid.current;
            const top = (menu.row + 1 - scrollFraction) * cellHeight + 6;
            element.style.left = `${Math.max(6, Math.min(menu.column * cellWidth, host.clientWidth - element.offsetWidth - 6))}px`;
            element.style.top = `${Math.max(
                6,
                Math.min(
                    top + element.offsetHeight <= host.clientHeight - cellHeight
                        ? top
                        : (menu.row - scrollFraction) * cellHeight - element.offsetHeight - 6,
                    host.clientHeight - element.offsetHeight - 6
                )
            )}px`;
        };
        position();
        element.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        anchor.setAttribute('aria-autocomplete', 'list');
        anchor.setAttribute('aria-controls', listId);
        if (menu.selected >= 0)
            anchor.setAttribute('aria-activedescendant', `${listId}-${menu.selected}`);
        const observer = new ResizeObserver(position);
        observer.observe(host);
        observer.observe(element);
        return () => {
            observer.disconnect();
            anchor.removeAttribute('aria-autocomplete');
            anchor.removeAttribute('aria-controls');
            anchor.removeAttribute('aria-activedescendant');
        };
    }, [menu, grid, input, listId, hidden]);
    if (!menu?.items.length || hidden) return null;
    return (
        <div
            ref={card}
            className={styles.card}
            style={{ fontFamily }}
            onMouseDown={(event) => event.preventDefault()}
        >
            <div className={styles.heading}>
                <Braces size={14} /> Completion <span>{menu.items.length} candidates</span>
            </div>
            <div id={listId} className={styles.list} role="listbox" aria-label="Code completion">
                {menu.items.map(([word, kind, detail], index) => (
                    <div
                        key={index}
                        id={`${listId}-${index}`}
                        className={styles.item}
                        role="option"
                        aria-selected={menu.selected === index}
                        title={detail || word}
                        onClick={() => {
                            const delta = index - menu.selected;
                            const keys =
                                (delta >= 0 ? '<C-n>' : '<C-p>').repeat(Math.abs(delta)) + '<C-y>';
                            void window.nido
                                .input(id, keys)
                                .catch((error) => onError(String(error)));
                            input.current?.focus();
                        }}
                    >
                        <span className={styles.kind}>{kind || 'Text'}</span>
                        <span className={styles.word}>{word}</span>
                        <span className={styles.detail}>{detail}</span>
                    </div>
                ))}
            </div>
            <div className={styles.footer}>
                <span>
                    <kbd>↑ ↓</kbd> Select
                </span>
                <span>
                    <kbd>Tab</kbd> Accept
                </span>
                <span>
                    <kbd>Esc</kbd> Close
                </span>
            </div>
        </div>
    );
}

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
    Blocks,
    Box,
    Braces,
    CaseSensitive,
    CircleDot,
    Code,
    File,
    Folder,
    KeyRound,
    Link,
    ListTree,
    Palette,
    PanelsTopLeft,
    Plus,
    Ruler,
    Text,
    Waypoints,
    Zap,
    type LucideIcon
} from 'lucide-react';
import type { Grid } from '../grid';
import styles from '../assets/CompletionMenu.module.css';

interface Menu {
    items: [string, string, string, string][];
    selected: number;
    row: number;
    column: number;
}

const kindIcons: Record<string, LucideIcon> = {
    Text,
    Method: Box,
    Function: Box,
    Constructor: Box,
    Field: PanelsTopLeft,
    Variable: KeyRound,
    Class: Blocks,
    Interface: Waypoints,
    Module: Braces,
    Property: PanelsTopLeft,
    Unit: Ruler,
    Value: CircleDot,
    Enum: ListTree,
    Keyword: CaseSensitive,
    Snippet: Code,
    Color: Palette,
    File,
    Reference: Link,
    Folder,
    EnumMember: ListTree,
    Constant: KeyRound,
    Struct: Blocks,
    Event: Zap,
    Operator: Plus,
    TypeParameter: CaseSensitive
};

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
                {menu.items.map(([word, kind, detail], index) => {
                    const Icon = Object.hasOwn(kindIcons, kind) ? kindIcons[kind] : Text;
                    return (
                        <div
                            key={index}
                            id={`${listId}-${index}`}
                            className={styles.item}
                            role="option"
                            aria-selected={menu.selected === index}
                            title={detail || word}
                            onClick={() => {
                                const keys = `<Cmd>lua vim.api.nvim_select_popupmenu_item(${index}, false, false, {})<CR>`;
                                void window.nido
                                    .input(id, keys)
                                    .catch((error) => onError(String(error)));
                                input.current?.focus();
                            }}
                        >
                            <span
                                className={styles.kind}
                                data-kind={kind}
                                role="img"
                                aria-label={kind || 'Text'}
                                title={kind || 'Text'}
                            >
                                <Icon size={16} aria-hidden="true" />
                            </span>
                            <span className={styles.word}>{word}</span>
                            <span className={styles.detail}>{detail}</span>
                        </div>
                    );
                })}
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

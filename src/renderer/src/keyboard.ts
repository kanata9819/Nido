export function isAltGraph(event: Partial<Pick<KeyboardEvent, 'getModifierState'>>): boolean {
    return event.getModifierState?.('AltGraph') === true;
}

export function vimKey(
    event: Pick<
        KeyboardEvent,
        'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'
    > &
        Partial<Pick<KeyboardEvent, 'getModifierState'>>
): string | null {
    if (
        event.isComposing ||
        ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(
            event.key
        )
    ) {
        return null;
    }

    const special: Record<string, string> = {
        Escape: 'Esc',
        Enter: 'CR',
        Backspace: 'BS',
        Delete: 'Del',
        Tab: 'Tab',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        Insert: 'Insert'
    };

    const altGraph = isAltGraph(event);
    const ctrlKey = event.ctrlKey && !altGraph;
    const altKey = event.altKey && !altGraph;
    let key = special[event.key] || event.key;
    if (/^F\d+$/.test(key) || special[event.key] || ctrlKey || altKey || event.metaKey) {
        if (key === ' ') {
            key = 'Space';
        }
        const modifiers =
            (ctrlKey ? 'C-' : '') +
            (altKey ? 'M-' : '') +
            (event.metaKey ? 'D-' : '') +
            (event.shiftKey && (special[event.key] || /^F\d+$/.test(event.key) || ctrlKey || altKey)
                ? 'S-'
                : '');
        return `<${modifiers}${key}>`;
    }
    return key === '<' ? '<LT>' : key;
}

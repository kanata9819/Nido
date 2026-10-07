// External Neovim UI content stays separate from the editor grid and workspace state.
export type MessageChunk = [highlight: number, text: string];
export interface NeovimMessage {
    kind: string;
    content: MessageChunk[];
}
export interface NeovimCommandLine {
    content: MessageChunk[];
    position: number;
    firstCharacter: string;
    prompt: string;
    indent: number;
    level: number;
    highlight: number;
    special?: { text: string; shift: boolean };
}
export interface NeovimUIState {
    commands: Record<number, NeovimCommandLine>;
    block: MessageChunk[][];
    messages: NeovimMessage[];
    history: NeovimMessage[] | null;
    showmode: MessageChunk[];
    showcmd: MessageChunk[];
    ruler: MessageChunk[];
    messageVersion: number;
    historyVersion: number;
    completion: { items: [string, string, string, string][]; selected: number } | null;
}

export function emptyNeovimUI(): NeovimUIState {
    return {
        commands: {},
        block: [],
        messages: [],
        history: null,
        showmode: [],
        showcmd: [],
        ruler: [],
        messageVersion: 0,
        historyVersion: 0,
        completion: null
    };
}

function chunks(value: unknown): MessageChunk[] {
    return Array.isArray(value)
        ? value
              .filter((item) => Array.isArray(item) && typeof item[1] === 'string')
              .map((item) => [Number(item[0]) || 0, item[1]])
        : [];
}

export function applyNeovimUI(state: NeovimUIState, name: string, args: unknown[]): NeovimUIState {
    switch (name) {
        case 'popupmenu_show':
            return Number(args[4]) === -1
                ? {
                      ...state,
                      completion: {
                          items: Array.isArray(args[0]) ? args[0] : [],
                          selected: Number(args[1])
                      }
                  }
                : state.completion
                  ? { ...state, completion: null }
                  : state;
        case 'popupmenu_select':
            return state.completion
                ? { ...state, completion: { ...state.completion, selected: Number(args[0]) } }
                : state;
        case 'popupmenu_hide':
            return state.completion ? { ...state, completion: null } : state;
        case 'cmdline_show': {
            const level = Number(args[5]);
            return {
                ...state,
                commands: {
                    ...state.commands,
                    [level]: {
                        content: chunks(args[0]),
                        position: Number(args[1]),
                        firstCharacter: String(args[2]),
                        prompt: String(args[3]),
                        indent: Number(args[4]),
                        level,
                        highlight: Number(args[6]) || 0
                    }
                }
            };
        }
        case 'cmdline_pos':
        case 'cmdline_special_char': {
            const level = Number(args[name === 'cmdline_pos' ? 1 : 2]);
            const command = state.commands[level];
            if (!command) {
                return state;
            }
            return {
                ...state,
                commands: {
                    ...state.commands,
                    [level]: {
                        ...command,
                        ...(name === 'cmdline_pos'
                            ? { position: Number(args[0]) }
                            : { special: { text: String(args[0]), shift: args[1] === true } })
                    }
                }
            };
        }
        case 'cmdline_hide': {
            const commands = { ...state.commands };
            delete commands[Number(args[0])];
            return { ...state, commands };
        }
        case 'cmdline_block_show':
            return { ...state, block: Array.isArray(args[0]) ? args[0].map(chunks) : [] };
        case 'cmdline_block_append':
            return { ...state, block: [...state.block, chunks(args[0])] };
        case 'cmdline_block_hide':
            return { ...state, block: [] };
        case 'msg_show': {
            const message = { kind: String(args[0]), content: chunks(args[1]) };
            const messages = args[2] === true ? state.messages.slice(0, -1) : state.messages;
            return {
                ...state,
                messages: [...messages, message],
                messageVersion: state.messageVersion + 1
            };
        }
        case 'msg_clear':
            return { ...state, messages: [], messageVersion: state.messageVersion + 1 };
        case 'msg_showmode':
            return { ...state, showmode: chunks(args[0]) };
        case 'msg_showcmd':
            return { ...state, showcmd: chunks(args[0]) };
        case 'msg_ruler':
            return { ...state, ruler: chunks(args[0]) };
        case 'msg_history_show':
            return {
                ...state,
                history: Array.isArray(args[0])
                    ? args[0].map((entry) => ({
                          kind: String(entry[0]),
                          content: chunks(entry[1])
                      }))
                    : [],
                historyVersion: state.historyVersion + 1
            };
        case 'msg_history_clear':
            return { ...state, history: null, historyVersion: state.historyVersion + 1 };
        default:
            return state;
    }
}

// Neovim positions are UTF-8 byte offsets; DOM text uses UTF-16 indices.
export function splitCommandContent(
    content: MessageChunk[],
    bytePosition: number
): {
    before: MessageChunk[];
    cursor: MessageChunk[];
    after: MessageChunk[];
} {
    const before: MessageChunk[] = [];
    const cursor: MessageChunk[] = [];
    const after: MessageChunk[] = [];
    let offset = 0;
    const encoder = new TextEncoder();
    for (const [highlight, text] of content) {
        const parts = ['', '', ''];
        for (const character of text) {
            const size = encoder.encode(character).length;
            const index = offset + size <= bytePosition ? 0 : offset <= bytePosition ? 1 : 2;
            parts[index] += character;
            offset += size;
        }
        if (parts[0]) {
            before.push([highlight, parts[0]]);
        }
        if (parts[1]) {
            cursor.push([highlight, parts[1]]);
        }
        if (parts[2]) {
            after.push([highlight, parts[2]]);
        }
    }
    return { before, cursor, after };
}

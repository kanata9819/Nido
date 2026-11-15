import { useEffect, useState } from 'react';
import { onNidoEvent } from '../nidoEvents';
import {
	emptyNeovimUI,
	patchNeovimUI,
	type MessageChunk,
	type NeovimCommandLine,
	type NeovimMessage,
	type NeovimUIState
} from '../../../shared/neovimUI';

/** The command line, messages and completion of workspace `id`, as the main process sends them. */
export function useNeovimUIState(id: string): NeovimUIState {
	const [state, setState] = useState(emptyNeovimUI);
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (event.id !== id) {
					return;
				}
				if (event.type === 'neovimUI') {
					setState(event.state);
				} else if (event.type === 'neovimUIPatch') {
					setState((previous) => patchNeovimUI(previous, event.state));
				}
			}),
		[id]
	);
	return state;
}

/** Which versions of the messages and the message history the user closed. */
export interface Dismissed {
	messages: number;
	history: number;
}

/** What NeovimUI shows for a state: which dialogs are open and with what. */
export interface NeovimUIView {
	/** Nested command lines, innermost last; the innermost one has the cursor. */
	commands: NeovimCommandLine[];
	current: NeovimCommandLine | undefined;
	showCommand: boolean;
	showCompletion: boolean;
	showHistory: boolean;
	messages: NeovimMessage[];
	showMessages: boolean;
	/** A confirm or hit-enter prompt waiting for an answer. */
	prompt: NeovimMessage | undefined;
	/** Mode, pending command and ruler text, shown with the command line. */
	auxiliary: MessageChunk[][];
}

export function neovimUIView(
	state: NeovimUIState,
	dismissed: Dismissed,
	hidden: boolean
): NeovimUIView {
	const commands = Object.values(state.commands).sort((a, b) => a.level - b.level);
	const current = commands.at(-1);
	const showCommand = !hidden && (Boolean(current) || state.block.length > 0);
	const showHistory = state.history !== null && dismissed.history !== state.historyVersion;
	const messages = showHistory ? state.history! : state.messages;
	return {
		commands,
		current,
		showCommand,
		showCompletion: showCommand && state.completion !== null,
		showHistory,
		messages,
		showMessages:
			!hidden &&
			(showHistory || (messages.length > 0 && dismissed.messages !== state.messageVersion)),
		prompt: state.messages.findLast(
			(message) => message.kind === 'confirm' || message.kind === 'return_prompt'
		),
		auxiliary: [state.showmode, state.showcmd, state.ruler].filter((content) => content.length)
	};
}

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Search, Terminal, X } from 'lucide-react';
import {
	splitCommandContent,
	type NeovimCommandLine,
	type NeovimUIState
} from '../../../shared/neovimUI';
import { useI18n } from '../i18n';
import { type Grid } from '../grid/grid';
import styles from './NeovimUI.module.css';
import OverlayPresence from '../ui/OverlayPresence';
import { virtualRows } from '../ui/virtualRows';
import { useListViewport } from '../ui/useListViewport';
import Chunks from './NeovimUIChunks';
import NeovimMessages from './NeovimMessages';
import { neovimUIView, useNeovimUIState } from './useNeovimUIState';
import { useCommandInputAnchor, useCompletionAria } from './useCommandLineInput';

// Command-line completion rows are drawn virtually, like the other long lists.
const completionRowHeight = 30;
const completionOverscan = 8;

/**
 * One level of Neovim's command line (a nested level appears for example with Ctrl+R=),
 * with the prompt, the typed text and the cursor.
 */
function CommandLine({
	command,
	grid,
	caret,
	current
}: {
	command: NeovimCommandLine;
	grid: Grid;
	caret: RefObject<HTMLSpanElement | null>;
	current: boolean;
}): React.JSX.Element {
	const { before, cursor, after } = splitCommandContent(command.content, command.position);
	return (
		<div className={styles.commandLine} data-current={current}>
			<span className={styles.prefix}>{command.firstCharacter}</span>
			<Chunks content={[[command.highlight, command.prompt]]} grid={grid} />
			{' '.repeat(Math.max(0, command.indent))}
			<Chunks content={before} grid={grid} />
			{current ? (
				<span ref={caret} className={styles.caret} data-neovim-caret>
					{command.special?.text ||
						(cursor.length ? <Chunks content={cursor} grid={grid} /> : ' ')}
				</span>
			) : (
				<Chunks content={cursor} grid={grid} />
			)}
			{command.special?.shift && <Chunks content={cursor} grid={grid} />}
			<Chunks content={after} grid={grid} />
		</div>
	);
}

/**
 * Nido's own drawing of Neovim's command line, messages and command-line completion (Neovim's
 * ext_cmdline, ext_messages and ext_popupmenu UI), from the state the main process sends.
 */
export default function NeovimUI({
	id,
	grid,
	input,
	paint,
	fontFamily,
	hidden,
	onError
}: {
	id: string;
	grid: RefObject<Grid>;
	input: RefObject<HTMLTextAreaElement | null>;
	paint: RefObject<() => void>;
	fontFamily: string;
	hidden: boolean;
	onError: (message: string) => void;
}): React.JSX.Element {
	const t = useI18n();
	const state = useNeovimUIState(id);
	// The message and history versions the user closed; newer messages open the dialog again.
	const [dismissed, setDismissed] = useState({ messages: -1, history: -1 });
	const caret = useRef<HTMLSpanElement>(null);
	const commandCard = useRef<HTMLDivElement>(null);
	const commandBody = useRef<HTMLDivElement>(null);
	const messageBody = useRef<HTMLDivElement>(null);
	const completionList = useRef<HTMLDivElement>(null);
	const view = neovimUIView(state, dismissed, hidden);
	const { commands, current, showCommand, showHistory, messages, showMessages, prompt } = view;

	/** Send keys to Neovim, keeping focus in the editor input. */
	const send = (keys: string): void => {
		void window.nido.input(id, keys).catch((error) => onError(String(error)));
		input.current?.focus();
	};
	/** Close the message dialog, answering a waiting prompt with Esc. */
	const closeMessages = (): void => {
		if (prompt) {
			send('<Esc>');
		}
		setDismissed({ messages: state.messageVersion, history: state.historyVersion });
		input.current?.focus();
	};

	// The layout effects run in this order: the completion viewport, the input at the command
	// cursor, the newest messages scrolled into view, and the completion for assistive technology.
	const completion = useListViewport(completionList, view.showCompletion, {
		top: 0,
		height: 280
	});
	useCommandInputAnchor({
		id,
		commands: state.commands,
		showCommand,
		current,
		inputRef: input,
		caretRef: caret,
		cardRef: commandCard,
		bodyRef: commandBody,
		paintRef: paint
	});
	useLayoutEffect(() => {
		if (!showMessages) {
			return;
		}
		const body = messageBody.current;
		if (body && !showHistory) {
			body.scrollTop = body.scrollHeight;
		}
	}, [showMessages, showHistory, state.messageVersion, state.historyVersion]);
	useCompletionAria({
		id,
		completion: state.completion,
		current,
		hidden,
		inputRef: input,
		cardRef: commandCard
	});

	const searching = current?.firstCharacter === '/' || current?.firstCharacter === '?';
	return (
		<>
			<OverlayPresence>
				{showCommand ? (
					<div
						ref={commandCard}
						className={styles.command}
						data-neovim-ui
						role="dialog"
						aria-label={t('Neovim command line')}
						style={{ fontFamily }}
						onMouseDown={(event) => {
							event.preventDefault();
							input.current?.focus();
						}}
					>
						<div className={styles.header} id={`neovim-command-${id}`}>
							{searching ? <Search size={15} /> : <Terminal size={15} />}
							<strong>{t(searching ? 'Search' : 'Command line')}</strong>
							<span className={styles.hint}>
								<kbd>Enter</kbd> {t('Run')} · <kbd>Esc</kbd> {t('Cancel')}
							</span>
							<button aria-label={t('Cancel command')} onClick={() => send('<Esc>')}>
								<X size={16} />
							</button>
						</div>
						<div
							ref={commandBody}
							className={styles.commandBody}
							aria-label={t('Command content')}
						>
							{state.block.map((line, index) => (
								<div key={index} className={styles.blockLine}>
									<Chunks content={line} grid={grid.current} />
								</div>
							))}
							{commands.map((command) => (
								<CommandLine
									key={command.level}
									command={command}
									grid={grid.current}
									caret={caret}
									current={command.level === current?.level}
								/>
							))}
						</div>
						<OverlayPresence>
							{state.completion ? (
								<div
									ref={completionList}
									className={styles.completion}
									id={`neovim-completion-${id}`}
									role="listbox"
									aria-label={t('Command completion')}
									onScroll={(event) => completion.scrolled(event.currentTarget)}
								>
									<CompletionRows
										id={id}
										completion={state.completion}
										indices={virtualRows(
											completion.viewport,
											state.completion.items.length,
											completionRowHeight,
											completionOverscan,
											{ selected: state.completion.selected, keepLast: true }
										)}
										select={(index) => {
											void window.nido
												.selectCompletion(id, index)
												.catch((error) => onError(String(error)));
											input.current?.focus();
										}}
									/>
								</div>
							) : null}
						</OverlayPresence>
					</div>
				) : null}
			</OverlayPresence>
			<NeovimMessages
				visible={showMessages}
				showHistory={showHistory}
				messages={messages}
				prompt={prompt}
				fontFamily={fontFamily}
				messageBody={messageBody}
				grid={grid}
				input={input}
				send={send}
				closeMessages={closeMessages}
			/>
			<OverlayPresence>
				{!hidden && view.auxiliary.length > 0 ? (
					<div
						className={styles.auxiliary}
						data-neovim-ui
						role="status"
						style={{ fontFamily }}
					>
						{view.auxiliary.map((content, index) => (
							<span key={index}>
								<Chunks content={content} grid={grid.current} />
							</span>
						))}
					</div>
				) : null}
			</OverlayPresence>
		</>
	);
}

/** The command-line completion items to draw, positioned in the full list's height. */
function CompletionRows({
	id,
	completion,
	indices,
	select
}: {
	id: string;
	completion: NonNullable<NeovimUIState['completion']>;
	indices: number[];
	select: (index: number) => void;
}): React.JSX.Element {
	const count = completion.items.length;
	return (
		<div className={styles.completionItems} style={{ height: count * completionRowHeight }}>
			{indices.map((index) => {
				const [word, , detail] = completion.items[index];
				return (
					<div
						key={index}
						role="option"
						id={`neovim-completion-${id}-${index}`}
						aria-posinset={index + 1}
						aria-setsize={count}
						aria-selected={index === completion.selected}
						style={{ top: index * completionRowHeight, height: completionRowHeight }}
						title={detail || word}
						onClick={() => select(index)}
					>
						<span>{word}</span>
						{detail && <small>{detail}</small>}
					</div>
				);
			})}
		</div>
	);
}

import { onNidoEvent } from '../nidoEvents';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Search, Terminal, X } from 'lucide-react';
import {
	emptyNeovimUI,
	patchNeovimUI,
	splitCommandContent,
	type NeovimCommandLine
} from '../../../shared/neovimUI';
import { useI18n } from '../i18n';
import { type Grid } from '../grid';
import styles from '../assets/NeovimUI.module.css';
import OverlayPresence from './OverlayPresence';
import Chunks from './NeovimUIChunks';
import NeovimMessages from './NeovimMessages';

// Command-line completion rows are drawn virtually, like the other long lists.
const completionRowHeight = 30;
const completionOverscan = 8;

// Keep the existing IME textarea aligned with the external command cursor.
function positionCommandInput(
	anchor: HTMLTextAreaElement,
	cursor: HTMLSpanElement,
	body: HTMLDivElement
): void {
	const bounds = cursor.getBoundingClientRect();
	const content = body.getBoundingClientRect();
	if (bounds.right > content.right - 8) {
		body.scrollLeft += bounds.right - content.right + 8;
	}
	if (bounds.left < content.left + 8) {
		body.scrollLeft += bounds.left - content.left - 8;
	}
	if (bounds.bottom > content.bottom) {
		body.scrollTop += bounds.bottom - content.bottom;
	}
	if (bounds.top < content.top) {
		body.scrollTop += bounds.top - content.top;
	}
	const host = anchor.parentElement!.getBoundingClientRect();
	const point = cursor.getBoundingClientRect();
	anchor.style.left = `${point.left - host.left}px`;
	anchor.style.top = `${point.top - host.top}px`;
	anchor.style.maxWidth = `${Math.max(2, host.right - point.left)}px`;
}

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
	const [state, setState] = useState(emptyNeovimUI);
	// The message and history versions the user closed; newer messages open the dialog again.
	const [dismissed, setDismissed] = useState({ messages: -1, history: -1 });
	const caret = useRef<HTMLSpanElement>(null);
	const commandCard = useRef<HTMLDivElement>(null);
	const commandBody = useRef<HTMLDivElement>(null);
	const messageBody = useRef<HTMLDivElement>(null);
	const completionList = useRef<HTMLDivElement>(null);
	const [completionViewport, setCompletionViewport] = useState({ top: 0, height: 280 });
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

	// Nested command lines, innermost last; the innermost one has the cursor.
	const commands = Object.values(state.commands).sort((a, b) => a.level - b.level);
	const current = commands.at(-1);
	const showCommand = !hidden && (Boolean(current) || state.block.length > 0);
	const showCompletion = showCommand && state.completion !== null;
	const completionCount = state.completion?.items.length ?? 0;
	// The completion rows to draw, plus the selected row when it is outside them.
	const firstCompletion = Math.min(
		Math.max(0, completionCount - 1),
		Math.max(0, Math.floor(completionViewport.top / completionRowHeight) - completionOverscan)
	);
	const lastCompletion = Math.min(
		completionCount,
		Math.ceil((completionViewport.top + completionViewport.height) / completionRowHeight) +
			completionOverscan
	);
	const completionIndices = Array.from(
		{ length: Math.max(0, lastCompletion - firstCompletion) },
		(_, index) => firstCompletion + index
	);
	const selectedCompletion = state.completion?.selected ?? -1;
	if (
		selectedCompletion >= 0 &&
		selectedCompletion < completionCount &&
		!completionIndices.includes(selectedCompletion)
	) {
		completionIndices.push(selectedCompletion);
		completionIndices.sort((a, b) => a - b);
	}
	const showHistory = state.history !== null && dismissed.history !== state.historyVersion;
	const messages = showHistory ? state.history! : state.messages;
	const showMessages =
		!hidden &&
		(showHistory || (messages.length > 0 && dismissed.messages !== state.messageVersion));
	// A confirm or hit-enter prompt waiting for an answer.
	const prompt = state.messages.findLast(
		(message) => message.kind === 'confirm' || message.kind === 'return_prompt'
	);
	// Mode, pending command and ruler text, shown with the command line.
	const auxiliary = [state.showmode, state.showcmd, state.ruler].filter(
		(content) => content.length
	);

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

	// Track the completion list's scroll position for virtual rendering.
	useLayoutEffect(() => {
		const list = completionList.current;
		if (!showCompletion || !list) {
			return;
		}
		const update = (): void => {
			const top = list.scrollTop;
			const height = list.clientHeight;
			setCompletionViewport((previous) =>
				previous.top === top && previous.height === height ? previous : { top, height }
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(list);
		return () => observer.disconnect();
	}, [showCompletion]);

	// While the command line is shown, move the editor's input element to its cursor so IME
	// composition appears there.
	useLayoutEffect(() => {
		const anchor = input.current;
		const cursor = caret.current;
		const card = commandCard.current;
		const body = commandBody.current;
		if (!showCommand || !current || !anchor || !cursor || !card || !body) {
			return;
		}
		anchor.setAttribute('data-nvim-command-active', '');
		anchor.setAttribute('aria-describedby', `neovim-command-${id}`);
		const position = (): void => positionCommandInput(anchor, cursor, body);
		position();
		const observer = new ResizeObserver(position);
		observer.observe(card);
		observer.observe(anchor.parentElement!);
		body.addEventListener('scroll', position);
		const repaint = paint.current;
		return () => {
			observer.disconnect();
			body.removeEventListener('scroll', position);
			anchor.removeAttribute('data-nvim-command-active');
			anchor.removeAttribute('aria-describedby');
			repaint();
		};
	}, [state.commands, showCommand, current, input, id, paint]);

	// Scroll new messages into view.
	useLayoutEffect(() => {
		if (!showMessages) {
			return;
		}
		const body = messageBody.current;
		if (body && !showHistory) {
			body.scrollTop = body.scrollHeight;
		}
	}, [showMessages, showHistory, state.messageVersion, state.historyVersion]);

	// Expose the command-line completion to assistive technology through the input element.
	useLayoutEffect(() => {
		const anchor = input.current;
		if (!anchor || !state.completion || !current || hidden) {
			return;
		}
		anchor.setAttribute('aria-autocomplete', 'list');
		anchor.setAttribute('aria-controls', `neovim-completion-${id}`);
		if (state.completion.selected >= 0) {
			anchor.setAttribute(
				'aria-activedescendant',
				`neovim-completion-${id}-${state.completion.selected}`
			);
		}
		commandCard.current
			?.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: 'nearest' });
		return () => {
			anchor.removeAttribute('aria-autocomplete');
			anchor.removeAttribute('aria-controls');
			anchor.removeAttribute('aria-activedescendant');
		};
	}, [state.completion, current, input, hidden, id]);

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
							{current?.firstCharacter === '/' || current?.firstCharacter === '?' ? (
								<Search size={15} />
							) : (
								<Terminal size={15} />
							)}
							<strong>
								{t(
									current?.firstCharacter === '/' ||
										current?.firstCharacter === '?'
										? 'Search'
										: 'Command line'
								)}
							</strong>
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
									onScroll={(event) => {
										const list = event.currentTarget;
										setCompletionViewport({
											top: list.scrollTop,
											height: list.clientHeight
										});
									}}
								>
									<div
										className={styles.completionItems}
										style={{ height: completionCount * completionRowHeight }}
									>
										{completionIndices.map((index) => {
											const [word, , detail] = state.completion!.items[index];
											return (
												<div
													key={index}
													role="option"
													id={`neovim-completion-${id}-${index}`}
													aria-posinset={index + 1}
													aria-setsize={completionCount}
													aria-selected={
														index === state.completion?.selected
													}
													style={{
														top: index * completionRowHeight,
														height: completionRowHeight
													}}
													title={detail || word}
													onClick={() => {
														void window.nido
															.selectCompletion(id, index)
															.catch((error) =>
																onError(String(error))
															);
														input.current?.focus();
													}}
												>
													<span>{word}</span>
													{detail && <small>{detail}</small>}
												</div>
											);
										})}
									</div>
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
				{!hidden && auxiliary.length > 0 ? (
					<div
						className={styles.auxiliary}
						data-neovim-ui
						role="status"
						style={{ fontFamily }}
					>
						{auxiliary.map((content, index) => (
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

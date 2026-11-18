import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import styles from './GitHub.module.css';

/**
 * A form for writing a comment, reply or review: a text area that sends with Ctrl+Enter, and
 * any `controls` (such as the kind of review) beside the send button. Esc cancels.
 */
export function Composer({
	label,
	submitLabel,
	busy,
	allowEmpty = false,
	ready = true,
	controls,
	onSubmit,
	onCancel
}: {
	label: string;
	submitLabel: string;
	busy: boolean;
	/** Whether sending without text is allowed, as for an approval. */
	allowEmpty?: boolean;
	/** Whether the form's other fields are complete; sending waits for them, cancelling does not. */
	ready?: boolean;
	controls?: ReactNode;
	/** Send the text; resolves to whether it was sent, so a failed send keeps the text. */
	onSubmit: (body: string) => Promise<boolean>;
	onCancel: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const [body, setBody] = useState('');
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => area.current?.focus(), []);
	const canSend = !busy && ready && (allowEmpty || !!body.trim());
	const send = (): void => {
		if (canSend) {
			void onSubmit(body).then((sent) => sent && setBody(''));
		}
	};
	return (
		<form
			className={styles.composer}
			aria-label={label}
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<textarea
				ref={area}
				aria-label={label}
				placeholder={label}
				value={body}
				readOnly={busy}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Enter' && event.ctrlKey) {
						event.preventDefault();
						send();
					} else if (event.key === 'Escape') {
						// Esc cancels this form only, not the view behind it.
						event.preventDefault();
						event.stopPropagation();
						if (!busy) {
							onCancel();
						}
					}
				}}
			/>
			<div className={styles.composerControls}>
				{controls}
				<span />
				<button type="button" disabled={busy} onClick={onCancel}>
					{t('Cancel (Esc)')}
				</button>
				<button type="submit" className={styles.primary} disabled={!canSend}>
					{submitLabel} <kbd>Ctrl+Enter</kbd>
				</button>
			</div>
		</form>
	);
}

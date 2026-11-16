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
	controls,
	onSubmit,
	onCancel
}: {
	label: string;
	submitLabel: string;
	busy: boolean;
	/** Whether sending without text is allowed, as for an approval. */
	allowEmpty?: boolean;
	controls?: ReactNode;
	onSubmit: (body: string) => Promise<void>;
	onCancel: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const [body, setBody] = useState('');
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => area.current?.focus(), []);
	const canSend = !busy && (allowEmpty || !!body.trim());
	const send = (): void => {
		if (canSend) {
			void onSubmit(body).then(() => setBody(''));
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
						onCancel();
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

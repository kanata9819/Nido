import { ChevronDown, ChevronUp, Columns2, Rows2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { DiffLayout } from '../diffView';
import styles from '../../assets/GitPanel.module.css';

/** The change counter with buttons for the previous (N) and next (n) change. */
export function DiffNavigation({
	count,
	active,
	jump
}: {
	count: number;
	/** The selected change, or -1. */
	active: number;
	jump: (direction: number) => void;
}): React.JSX.Element {
	const t = useI18n();
	const buttons = [
		{ direction: -1, title: t('Previous change (N)'), Icon: ChevronUp },
		{ direction: 1, title: t('Next change (n)'), Icon: ChevronDown }
	];
	return (
		<div className={styles.diffNavigation}>
			<span>
				{active < 0
					? t('{count} changes', { count })
					: t('Change {current} / {total}', { current: active + 1, total: count })}{' '}
				· n / N
			</span>
			{buttons.map(({ direction, title, Icon }) => (
				<button
					key={direction}
					aria-label={title}
					title={title}
					onClick={() => jump(direction)}
				>
					<Icon size={16} aria-hidden="true" />
				</button>
			))}
		</div>
	);
}

/** Buttons for the side-by-side and inline layouts (v switches). */
export function LayoutSwitch({
	layout,
	toggle
}: {
	layout: DiffLayout;
	toggle: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const layouts = [
		{ value: 'split', title: t('Side by side'), Icon: Columns2 },
		{ value: 'unified', title: t('Inline'), Icon: Rows2 }
	] as const;
	return (
		<div className={styles.layoutSwitch} role="group" aria-label={t('Diff layout (v)')}>
			{layouts.map(({ value, title, Icon }) => (
				<button
					key={value}
					aria-label={title}
					title={`${title} (v)`}
					aria-pressed={layout === value}
					onClick={() => {
						if (layout !== value) {
							toggle();
						}
					}}
				>
					<Icon size={15} aria-hidden="true" />
				</button>
			))}
		</div>
	);
}

/** The heading of a pane: which version it shows, or both versions for the inline layout. */
export function PaneHeading({
	layout,
	side,
	beforeLabel,
	afterLabel
}: {
	layout: DiffLayout;
	side: 'before' | 'after';
	beforeLabel: string;
	afterLabel: string;
}): React.JSX.Element {
	const t = useI18n();
	if (layout === 'split') {
		return (
			<>
				<strong>{side === 'before' ? t('Before') : t('After')}</strong>
				<span>{side === 'before' ? beforeLabel : afterLabel}</span>
			</>
		);
	}
	return (
		<>
			<strong>{t('Before')}</strong>
			<span>{beforeLabel}</span>
			<span aria-hidden="true">→</span>
			<strong>{t('After')}</strong>
			<span>{afterLabel}</span>
		</>
	);
}

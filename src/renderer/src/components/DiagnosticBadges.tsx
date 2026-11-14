import { CircleX, TriangleAlert } from 'lucide-react';
import type { Decoration } from '../fileDecorations';
import styles from '../assets/Nido.module.css';
import { useI18n } from '../i18n';

/** Error and warning counts shown next to a file or folder in the explorer and tabs. */
export default function DiagnosticBadges({
	decoration
}: {
	decoration?: Decoration;
}): React.JSX.Element {
	const t = useI18n();
	return (
		<>
			{(
				[
					['error', decoration?.errors, CircleX],
					['warning', decoration?.warnings, TriangleAlert]
				] as const
			).map(([severity, count, Icon]) => {
				if (!count) {
					return null;
				}
				// Message keys such as "{count} error" and "{count} warnings".
				const label = t(`{count} ${severity}${count === 1 ? '' : 's'}`, { count });
				return (
					<span
						key={severity}
						className={styles.diagnosticCount}
						data-diagnostic={severity}
						title={label}
						aria-label={label}
					>
						<Icon size={12} aria-hidden="true" />
						{count}
					</span>
				);
			})}
		</>
	);
}

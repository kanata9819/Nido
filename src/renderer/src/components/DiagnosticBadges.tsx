import { CircleX, TriangleAlert } from 'lucide-react';
import type { Decoration } from '../fileDecorations';
import styles from '../assets/Nido.module.css';
import { useI18n } from '../i18n';

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
            ).map(([severity, count, Icon]) =>
                count ? (
                    <span
                        key={severity}
                        className={styles.diagnosticCount}
                        data-diagnostic={severity}
                        title={t(`{count} ${severity}${count === 1 ? '' : 's'}`, { count })}
                        aria-label={t(`{count} ${severity}${count === 1 ? '' : 's'}`, { count })}
                    >
                        <Icon size={12} aria-hidden="true" />
                        {count}
                    </span>
                ) : null
            )}
        </>
    );
}

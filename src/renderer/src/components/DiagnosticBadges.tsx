import { CircleX, TriangleAlert } from 'lucide-react';
import type { Decoration } from '../fileDecorations';
import styles from '../assets/Nido.module.css';

export default function DiagnosticBadges({
    decoration
}: {
    decoration?: Decoration;
}): React.JSX.Element {
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
                        title={`${count} ${severity}${count === 1 ? '' : 's'}`}
                        aria-label={`${count} ${severity}${count === 1 ? '' : 's'}`}
                    >
                        <Icon size={12} aria-hidden="true" />
                        {count}
                    </span>
                ) : null
            )}
        </>
    );
}

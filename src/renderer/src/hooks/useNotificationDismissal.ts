import { useEffect, useState } from 'react';

export function useNotificationDismissal(
    notice: { message: string } | undefined,
    animations: boolean,
    dismiss: () => void
): boolean {
    const [fading, setFading] = useState(false);
    useEffect(() => {
        setFading(false);
        if (!notice) {
            return;
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                dismiss();
            }
        };
        document.addEventListener('keydown', onKey);
        let fadeTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
            if (animations) {
                setFading(true);
                fadeTimer = setTimeout(dismiss, 300);
            } else {
                dismiss();
            }
        }, 2000);
        return () => {
            clearTimeout(timer);
            clearTimeout(fadeTimer);
            document.removeEventListener('keydown', onKey);
        };
    }, [notice, animations, dismiss]);
    return fading;
}

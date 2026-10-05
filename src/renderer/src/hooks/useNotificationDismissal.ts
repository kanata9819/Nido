import { useEffect, useState } from 'react';

export function useNotificationDismissal(
    notice: { message: string } | undefined,
    animations: boolean,
    dismiss: () => void
): boolean {
    const [fading, setFading] = useState<{
        notice: typeof notice;
        animations: boolean;
        dismiss: typeof dismiss;
    }>();
    useEffect(() => {
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
                setFading({ notice, animations, dismiss });
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
    return (
        !!notice &&
        fading?.notice === notice &&
        fading.animations === animations &&
        fading.dismiss === dismiss
    );
}

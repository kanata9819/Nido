import { useEffect, useState } from 'react';

export function usePointerVisibility(): boolean {
    const [pointerHidden, setPointerHidden] = useState(false);
    useEffect(() => {
        const hide = (): void => setPointerHidden(true);
        const show = (): void => setPointerHidden(false);
        const move = (event: PointerEvent): void => {
            if (event.movementX || event.movementY) {
                show();
            }
        };
        window.addEventListener('keydown', hide, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerdown', show, true);
        window.addEventListener('blur', show);
        return () => {
            window.removeEventListener('keydown', hide, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerdown', show, true);
            window.removeEventListener('blur', show);
        };
    }, []);
    return pointerHidden;
}

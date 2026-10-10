import { createContext, useSyncExternalStore } from 'react';

export const OverlayMotionContext = createContext(false);
export const overlayMotionDuration = 130;

function subscribe(listener: () => void): () => void {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', listener);
    return () => preference.removeEventListener('change', listener);
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        () => false
    );
}

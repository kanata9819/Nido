import { createContext, useSyncExternalStore } from 'react';

/** Whether overlays animate (the animations setting is on and reduced motion is not requested). */
export const OverlayMotionContext = createContext(false);
/** How long an overlay takes to fade, in milliseconds; matches OverlayMotion.css. */
export const overlayMotionDuration = 130;

function subscribe(listener: () => void): () => void {
	const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
	preference.addEventListener('change', listener);
	return () => preference.removeEventListener('change', listener);
}

/** Whether the system asks for reduced motion, updated when that changes. */
export function useReducedMotion(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		() => false
	);
}

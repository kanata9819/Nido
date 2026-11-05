import type { KeyboardEvent, SetStateAction } from 'react';

export const navigateSearchList = (
	event: KeyboardEvent,
	count: number,
	move: (value: SetStateAction<number>) => void
): boolean => {
	const key = event.key;
	if (
		!['j', 'k', 'g', 'G', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) ||
		event.altKey ||
		event.metaKey ||
		(event.ctrlKey && !['j', 'k'].includes(key))
	) {
		return false;
	}
	event.preventDefault();
	move((index) =>
		Math.max(
			0,
			Math.min(
				count - 1,
				['g', 'Home'].includes(key)
					? 0
					: ['G', 'End'].includes(key)
						? count - 1
						: index + (['j', 'ArrowDown'].includes(key) ? 1 : -1)
			)
		)
	);
	return true;
};

import { useCallback, useEffect, useState } from 'react';
import { onNidoEvent } from '../nidoEvents';

export function useInitializedEditors(): {
	initializedEditors: ReadonlySet<string>;
	finishEditorLoading: (id: string) => void;
} {
	const [initializedEditors, setInitializedEditors] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const finishEditorLoading = useCallback((id: string): void => {
		setInitializedEditors((old) => (old.has(id) ? old : new Set([...old, id])));
	}, []);
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (event.type === 'exit') {
					setInitializedEditors((old) => {
						if (!old.has(event.id)) {
							return old;
						}
						const next = new Set(old);
						next.delete(event.id);
						return next;
					});
				}
			}),
		[]
	);
	return { initializedEditors, finishEditorLoading };
}

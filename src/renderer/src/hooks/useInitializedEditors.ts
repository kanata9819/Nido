import { useCallback, useEffect, useState } from 'react';
import { onNidoEvent } from '../nidoEvents';

/** The workspaces whose editor has drawn its first frame; a workspace that exits is forgotten. */
export function useInitializedEditors(): {
	initializedEditors: ReadonlySet<string>;
	finishEditorLoading: (id: string) => void;
	forgetEditor: (id: string) => void;
} {
	const [initializedEditors, setInitializedEditors] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const finishEditorLoading = useCallback((id: string): void => {
		setInitializedEditors((old) => (old.has(id) ? old : new Set([...old, id])));
	}, []);
	const forgetEditor = useCallback((id: string): void => {
		setInitializedEditors((old) => {
			if (!old.has(id)) {
				return old;
			}
			const next = new Set(old);
			next.delete(id);
			return next;
		});
	}, []);
	useEffect(
		() =>
			onNidoEvent((event) => {
				if (event.type === 'exit') {
					forgetEditor(event.id);
				}
			}),
		[forgetEditor]
	);
	return { initializedEditors, finishEditorLoading, forgetEditor };
}

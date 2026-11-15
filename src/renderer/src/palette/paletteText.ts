// The texts of a palette that depend on what it shows.
import type { Translator } from '../../../shared/i18n';
import type { Panel } from '../types';

type OpenPanel = Exclude<Panel, null>;

/** The filter field's placeholder. */
export function placeholder(panel: OpenPanel, t: Translator): string {
	switch (panel) {
		case 'files':
			return t('Type a filename…');
		case 'symbols':
			return t('Type a symbol name…');
		case 'search':
			return t('Type text to grep…');
		default:
			return t('Type to search…');
	}
}

/** Shown instead of the list when nothing matches: progress, an error, or a hint. */
export function emptyMessage(
	{
		panel,
		loading,
		message,
		query
	}: { panel: OpenPanel; loading: boolean; message?: string; query: string },
	t: Translator
): string {
	if (loading) {
		return panel === 'symbols' ? t('Loading symbols…') : t('Looking through your project…');
	}
	if (message) {
		return t(message);
	}
	if (panel === 'search') {
		return query ? t('No matching lines.') : t('Enter text to search this workspace.');
	}
	return panel === 'problems' && !query ? t('No problems reported.') : t('No matching items.');
}

/** The help for the list (Normal mode) and for typing in the filter field. */
export function hint(
	{ panel, typing, count }: { panel: OpenPanel; typing: boolean; count: number },
	t: Translator
): string {
	if (typing) {
		return t('Typing · ↑ ↓ Move · Esc / Ctrl+C Back to the list');
	}
	if (panel === 'problems') {
		return t('{count} problems · j/k Select · i / Filter', { count });
	}
	if (panel === 'workspaces') {
		return t('j/k Select · Shift+J/K Reorder · i / Filter · Ctrl+S Sleep');
	}
	return panel === 'buffers'
		? t('j/k Select · Shift+J/K Reorder · i / Filter')
		: t('j/k Move · i / Filter');
}

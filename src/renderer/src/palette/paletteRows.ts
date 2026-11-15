import type { Panel } from '../types';

/** Whether a palette's rows are listbox options (Problems and symbols). */
export const hasOptions = (panel: Exclude<Panel, null>): boolean =>
	panel === 'problems' || panel === 'symbols';

/** The id of a Problems or symbols row, which aria-activedescendant refers to. */
export const paletteOptionId = (panel: Exclude<Panel, null>, index: number): string =>
	`${panel === 'problems' ? 'problem' : 'symbol'}-${index}`;

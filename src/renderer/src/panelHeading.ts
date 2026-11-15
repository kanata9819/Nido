import { createContext } from 'react';

/**
 * A place in the open panel's heading row where the panel's content can put controls, such
 * as the Git views, so they do not need a row of their own. Null outside a panel.
 */
export const PanelHeadingSlot = createContext<HTMLElement | null>(null);

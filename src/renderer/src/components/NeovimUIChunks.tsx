import type { CSSProperties } from 'react';
import type { MessageChunk } from '../../../shared/neovimUI';
import { color } from '../gridColors';
import type { Grid } from '../grid';

/**
 * Text from Neovim's command line or messages, colored with the highlight groups of the
 * editor grid.
 */
export default function NeovimUIChunks({
	content,
	grid
}: {
	content: MessageChunk[];
	grid: Grid;
}): React.JSX.Element {
	return (
		<>
			{content.map(([id, text], index) => {
				const highlight = grid.highlights.get(id);
				const foreground = highlight?.reverse
					? highlight.background
					: highlight?.foreground;
				const style: CSSProperties = {
					color: foreground === undefined ? undefined : color(foreground),
					fontWeight: highlight?.bold ? 700 : undefined,
					fontStyle: highlight?.italic ? 'italic' : undefined
				};
				return (
					<span key={index} style={style}>
						{text}
					</span>
				);
			})}
		</>
	);
}

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../../../i18n';
import type { NidoEvent } from '../../../../../shared/types';
import styles from '../TypeInformation.module.css';

type Hover = Extract<NidoEvent, { type: 'hover' }>;

/**
 * The hover's Markdown documentation. Code blocks use the colors Neovim gave them, matched by
 * their position in the source; other code blocks stay plain. Only web links are links, and
 * images show their text.
 */
export default function HoverMarkdown({
	markdown,
	codeBlocks,
	openLink
}: {
	markdown: string;
	codeBlocks: Hover['codeBlocks'];
	openLink: (href: string) => void;
}): React.JSX.Element {
	const t = useI18n();
	const highlights = new Map(
		[...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)].map((match, index) => [
			match.index,
			codeBlocks[index]
		])
	);
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			skipHtml
			components={{
				img: ({ alt }) => <span>{alt}</span>,
				a: ({ href, children }) =>
					href && /^https?:\/\//i.test(href) ? (
						<a
							href={href}
							onClick={(event) => {
								event.preventDefault();
								openLink(href);
							}}
						>
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
				pre: ({ node, children }) => {
					const lines = highlights.get(node?.position?.start.offset ?? -1);
					return (
						<section className={styles.code}>
							<pre>
								{lines?.length ? (
									<code>
										{lines.map((line, row) => (
											<span key={row}>
												{row > 0 && '\n'}
												{line.map((span, col) => (
													<span key={col} style={{ color: span.color }}>
														{span.text}
													</span>
												))}
											</span>
										))}
									</code>
								) : (
									children
								)}
							</pre>
						</section>
					);
				}
			}}
		>
			{/* Nido's own notices, such as "No type information at this position." */}
			{t(markdown)}
		</Markdown>
	);
}

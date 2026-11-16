import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import prose from '../ui/Prose.module.css';

/**
 * GitHub Markdown (a description or a comment), without HTML or images. Links open in the
 * browser. An empty text shows a dimmed note instead.
 */
export const GitHubMarkdown = memo(function GitHubMarkdown({
	source
}: {
	source: string;
}): React.JSX.Element {
	const t = useI18n();
	if (!source.trim()) {
		return <p className={prose.prose}>{t('No description provided.')}</p>;
	}
	return (
		<div className={prose.prose}>
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
									void window.nido.openDocumentation(href);
								}}
							>
								{children}
							</a>
						) : (
							<span>{children}</span>
						)
				}}
			>
				{source}
			</Markdown>
		</div>
	);
});

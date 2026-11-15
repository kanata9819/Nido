import { useLayoutEffect, useRef, useState } from 'react';
import { Blocks, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import styles from '../assets/ExtensionsPage.module.css';
import LanguagePacksPanel from './LanguagePacksPanel';

/** The tabs of the Extensions page. */
const views = ['languages', 'other'] as const;
const viewTitles = { languages: 'Languages', other: 'Other extensions' } as const;

/** The Extensions page (Ctrl+Shift+X): language packs and other extensions, with a search. */
export default function ExtensionsPage({
	onClose,
	workspaceId
}: {
	onClose: () => void;
	workspaceId?: string;
}): React.JSX.Element {
	const t = useI18n();
	const [view, setView] = useState<(typeof views)[number]>('languages');
	const [query, setQuery] = useState('');
	const search = useRef<HTMLInputElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	useLayoutEffect(() => search.current?.focus(), []);
	// Switch tabs, clearing the search and scrolling back to the top.
	const selectView = (next: typeof view): void => {
		setView(next);
		setQuery('');
		content.current?.scrollTo({ top: 0 });
	};

	return (
		<section className={styles.page} aria-label={t('Extensions')}>
			<header className={styles.header}>
				<div className={styles.title}>
					<Blocks size={20} />
					<h1>{t('Extensions')}</h1>
					<kbd>Ctrl+Shift+X</kbd>
				</div>
				<button
					aria-label={t('Close extensions')}
					title={t('Close extensions')}
					onClick={onClose}
				>
					<X size={18} />
				</button>
			</header>
			<div className={styles.tabs} role="tablist" aria-label={t('Extension categories')}>
				{views.map((tab, index) => (
					<button
						key={tab}
						ref={(element) => {
							tabs.current[index] = element;
						}}
						id={`extensions-tab-${tab}`}
						role="tab"
						aria-controls="extensions-content"
						aria-selected={view === tab}
						tabIndex={view === tab ? 0 : -1}
						onClick={() => selectView(tab)}
						// Arrow keys, Home and End move between tabs (the ARIA tabs pattern).
						onKeyDown={(event) => {
							let next: number;
							if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
								next =
									(index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) %
									views.length;
							} else if (event.key === 'Home') {
								next = 0;
							} else if (event.key === 'End') {
								next = views.length - 1;
							} else {
								return;
							}
							event.preventDefault();
							selectView(views[next]);
							tabs.current[next]?.focus();
						}}
					>
						{t(viewTitles[tab])}
					</button>
				))}
			</div>
			<div
				ref={content}
				id="extensions-content"
				className={styles.content}
				role="tabpanel"
				aria-labelledby={`extensions-tab-${view}`}
				tabIndex={0}
			>
				<div className={styles.intro}>
					<span className={styles.eyebrow}>NIDO / {t('Extensions')}</span>
					<h2>{t(view === 'languages' ? 'Language packs' : 'Other extensions')}</h2>
					{view === 'languages' && (
						<p>{t('Manage language support for your workspaces.')}</p>
					)}
				</div>
				<div className={styles.toolbar}>
					<label className={styles.search}>
						<Search size={17} />
						<input
							ref={search}
							aria-label={t(
								view === 'languages'
									? 'Search language packs'
									: 'Search other extensions'
							)}
							placeholder={t(
								view === 'languages'
									? 'Search language packs'
									: 'Search other extensions'
							)}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
				</div>
				<LanguagePacksPanel
					key={workspaceId ?? ''}
					workspaceId={workspaceId}
					query={query}
					category={view === 'languages' ? 'language' : 'other'}
				/>
			</div>
		</section>
	);
}

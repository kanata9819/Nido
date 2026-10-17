import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Blocks, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { builtinFeatures, featureCategories } from '../features';
import { languageCategories, supportedLanguages } from '../languages';
import styles from '../assets/FeaturesPage.module.css';
import LanguagePacksPanel from './LanguagePacksPanel';
import type { LanguagePackSnapshot } from '../../../shared/languagePacks';

export default function FeaturesPage({
    onClose,
    workspaceId
}: {
    onClose: () => void;
    workspaceId?: string;
}): React.JSX.Element {
    const t = useI18n();
    const [view, setView] = useState<'languages' | 'features' | 'packs'>('languages');
    const [snapshot, setSnapshot] = useState<LanguagePackSnapshot>();
    useEffect(() => {
        let active = true;
        void window.nido
            .languagePacks(workspaceId)
            .then((next) => {
                if (active) {
                    setSnapshot(next);
                }
            })
            .catch(() => {});
        return () => {
            active = false;
        };
    }, [workspaceId]);
    const [query, setQuery] = useState('');
    const search = useRef<HTMLInputElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const tabs = useRef<(HTMLButtonElement | null)[]>([]);
    useLayoutEffect(() => search.current?.focus(), []);
    const views = ['languages', 'features', 'packs'] as const;
    const viewTitles = {
        languages: 'Languages & runtimes',
        features: 'Built-in features',
        packs: 'Language packs'
    } as const;
    const selectView = (next: typeof view): void => {
        setView(next);
        setQuery('');
        content.current?.scrollTo({ top: 0 });
    };
    const needle = query.trim().toLocaleLowerCase();
    const features = builtinFeatures.filter((feature) =>
        [feature.title, feature.description, t(feature.title), t(feature.description)].some(
            (value) => value.toLocaleLowerCase().includes(needle)
        )
    );
    const additions = snapshot?.packs.flatMap((pack) => pack.languages ?? []) ?? [];
    const catalog = [
        ...supportedLanguages.filter(
            (language) => !additions.some((item) => item.id === language.id)
        ),
        ...additions
    ];
    const languages = catalog.filter((language) =>
        [
            language.title,
            language.keywords ?? '',
            language.extensions,
            language.description,
            t(language.description),
            language.setup ?? '',
            t(language.setup ?? ''),
            language.command ?? '',
            language.requirement ?? '',
            t(language.requirement ?? ''),
            t(languageCategories.find((category) => category.id === language.category)!.title)
        ].some((value) => value.toLocaleLowerCase().includes(needle))
    );
    const isLanguages = view === 'languages';

    return (
        <section className={styles.page} aria-label={t('Features')}>
            <header className={styles.header}>
                <div className={styles.title}>
                    <Blocks size={20} />
                    <h1>{t('Features')}</h1>
                    <kbd>Ctrl+Shift+X</kbd>
                </div>
                <button
                    aria-label={t('Close features')}
                    title={t('Close features')}
                    onClick={onClose}
                >
                    <X size={18} />
                </button>
            </header>
            <div className={styles.tabs} role="tablist" aria-label={t('Feature catalog')}>
                {views.map((tab, index) => (
                    <button
                        key={tab}
                        ref={(element) => {
                            tabs.current[index] = element;
                        }}
                        id={`catalog-tab-${tab}`}
                        role="tab"
                        aria-controls="catalog-content"
                        aria-selected={view === tab}
                        tabIndex={view === tab ? 0 : -1}
                        onClick={() => selectView(tab)}
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
                id="catalog-content"
                className={styles.content}
                role="tabpanel"
                aria-labelledby={`catalog-tab-${view}`}
                tabIndex={0}
            >
                <div className={styles.intro}>
                    <span className={styles.eyebrow}>NIDO / {t(viewTitles[view])}</span>
                    <h2>
                        {t(
                            view === 'packs'
                                ? 'Language packs'
                                : isLanguages
                                  ? 'Languages & runtimes'
                                  : 'Discover what Nido can do.'
                        )}
                    </h2>
                    <p>
                        {t(
                            view === 'packs'
                                ? 'Manage language support for your workspaces.'
                                : isLanguages
                                  ? 'See supported languages, runtimes, available tools and setup requirements.'
                                  : 'Explore the features included with Nido.'
                        )}
                    </p>
                </div>
                <div className={styles.toolbar}>
                    <label className={styles.search}>
                        <Search size={17} />
                        <input
                            ref={search}
                            aria-label={t(
                                view === 'packs'
                                    ? 'Search language packs'
                                    : isLanguages
                                      ? 'Search languages and runtimes'
                                      : 'Search features'
                            )}
                            placeholder={t(
                                view === 'packs'
                                    ? 'Search language packs'
                                    : isLanguages
                                      ? 'Search languages, runtimes or file extensions'
                                      : 'Search built-in features'
                            )}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    {view !== 'packs' && (
                        <span className={styles.count} role="status">
                            {t('Showing {count} of {total}', {
                                count: isLanguages ? languages.length : features.length,
                                total: isLanguages ? catalog.length : builtinFeatures.length
                            })}
                        </span>
                    )}
                </div>
                {isLanguages && (
                    <>
                        {languageCategories.map((category) => {
                            const items = languages.filter(
                                (language) => language.category === category.id
                            );
                            if (!items.length) {
                                return null;
                            }
                            return (
                                <section
                                    className={styles.category}
                                    key={category.id}
                                    aria-label={t(category.title)}
                                >
                                    <h3>
                                        {t(category.title)} <span>{items.length}</span>
                                    </h3>
                                    {category.description && (
                                        <p className={styles.categoryDescription}>
                                            {t(category.description)}
                                        </p>
                                    )}
                                    <ul className={styles.grid}>
                                        {items.map((language) => (
                                            <li
                                                className={styles.card}
                                                key={language.id}
                                                data-language={language.id}
                                            >
                                                <div className={styles.cardHeading}>
                                                    <div className={styles.languageTitle}>
                                                        <span
                                                            className={styles.languageMark}
                                                            aria-hidden="true"
                                                        >
                                                            {language.mark}
                                                        </span>
                                                        <div>
                                                            <h4>{language.title}</h4>
                                                            <code className={styles.extensions}>
                                                                {language.extensions}
                                                            </code>
                                                        </div>
                                                    </div>
                                                    <span
                                                        className={
                                                            language.requirement
                                                                ? styles.neutralBadge
                                                                : styles.badge
                                                        }
                                                    >
                                                        {t(language.requirement ?? 'Built-in')}
                                                    </span>
                                                </div>
                                                <p>{t(language.description)}</p>
                                                {language.setup && (
                                                    <div className={styles.setup}>
                                                        <h5>{t('Setup')}</h5>
                                                        <p>{t(language.setup)}</p>
                                                        {language.command && (
                                                            <code className={styles.installCommand}>
                                                                {language.command}
                                                            </code>
                                                        )}
                                                    </div>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            );
                        })}
                        {!languages.length && (
                            <p className={styles.empty}>
                                {t('No languages or runtimes match your search.')}
                            </p>
                        )}
                    </>
                )}
                {view === 'packs' && (
                    <LanguagePacksPanel
                        workspaceId={workspaceId}
                        query={query}
                        onChange={setSnapshot}
                    />
                )}
                {view === 'features' &&
                    featureCategories.map((category) => {
                        const items = features.filter(
                            (feature) => feature.category === category.id
                        );
                        if (!items.length) {
                            return null;
                        }
                        return (
                            <section
                                className={styles.category}
                                key={category.id}
                                aria-label={t(category.title)}
                            >
                                <h3>
                                    {t(category.title)} <span>{items.length}</span>
                                </h3>
                                <ul className={styles.grid}>
                                    {items.map((feature) => (
                                        <li
                                            className={styles.card}
                                            key={feature.id}
                                            data-feature={feature.id}
                                        >
                                            <div className={styles.cardHeading}>
                                                <h4>{t(feature.title)}</h4>
                                                <span className={styles.badge}>
                                                    {t('Built-in')}
                                                </span>
                                            </div>
                                            <p>{t(feature.description)}</p>
                                            {feature.shortcut && <kbd>{feature.shortcut}</kbd>}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        );
                    })}
                {view === 'features' && !features.length && (
                    <p className={styles.empty}>{t('No features match your search.')}</p>
                )}
            </div>
        </section>
    );
}

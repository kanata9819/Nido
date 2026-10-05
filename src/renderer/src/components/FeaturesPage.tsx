import { useLayoutEffect, useRef, useState } from 'react';
import { Blocks, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { builtinFeatures, featureCategories } from '../features';
import { languageCategories, supportedLanguages } from '../languages';
import styles from '../assets/FeaturesPage.module.css';

export default function FeaturesPage({ onClose }: { onClose: () => void }): React.JSX.Element {
    const t = useI18n();
    const [view, setView] = useState<'languages' | 'features'>('languages');
    const [query, setQuery] = useState('');
    const search = useRef<HTMLInputElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const tabs = useRef<(HTMLButtonElement | null)[]>([]);
    useLayoutEffect(() => search.current?.focus(), []);
    const views = ['languages', 'features'] as const;
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
    const languages = supportedLanguages.filter((language) =>
        [
            language.title,
            language.keywords ?? '',
            language.extensions,
            language.description,
            t(language.description),
            language.setup ?? '',
            t(language.setup ?? ''),
            language.command ?? '',
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
                                next = (index + 1) % views.length;
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
                        {t(tab === 'languages' ? 'Languages' : 'Built-in features')}
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
                    <span className={styles.eyebrow}>
                        NIDO / {t(isLanguages ? 'Languages' : 'Built-in')}
                    </span>
                    <h2>{t(isLanguages ? 'Languages' : 'Discover what Nido can do.')}</h2>
                    <p>
                        {t(
                            isLanguages
                                ? 'See which languages are supported and what you need to get started.'
                                : 'Explore the features included with Nido.'
                        )}
                    </p>
                </div>
                <div className={styles.toolbar}>
                    <label className={styles.search}>
                        <Search size={17} />
                        <input
                            ref={search}
                            aria-label={t(isLanguages ? 'Search languages' : 'Search features')}
                            placeholder={t(
                                isLanguages
                                    ? 'Search languages or file extensions'
                                    : 'Search built-in features'
                            )}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <span className={styles.count} role="status">
                        {t('Showing {count} of {total}', {
                            count: isLanguages ? languages.length : features.length,
                            total: isLanguages ? supportedLanguages.length : builtinFeatures.length
                        })}
                    </span>
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
                                                            language.command
                                                                ? styles.neutralBadge
                                                                : styles.badge
                                                        }
                                                    >
                                                        {t(
                                                            language.command
                                                                ? 'Requires Rust'
                                                                : 'Built-in'
                                                        )}
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
                            <p className={styles.empty}>{t('No languages match your search.')}</p>
                        )}
                    </>
                )}
                {!isLanguages &&
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
                {!isLanguages && !features.length && (
                    <p className={styles.empty}>{t('No features match your search.')}</p>
                )}
            </div>
        </section>
    );
}

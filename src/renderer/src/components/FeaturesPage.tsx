import { useLayoutEffect, useRef, useState } from 'react';
import { Blocks, Search, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { builtinFeatures, featureCategories } from '../features';
import styles from '../assets/FeaturesPage.module.css';

export default function FeaturesPage({ onClose }: { onClose: () => void }): React.JSX.Element {
    const t = useI18n();
    const [query, setQuery] = useState('');
    const search = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => search.current?.focus(), []);
    const needle = query.trim().toLocaleLowerCase();
    const features = builtinFeatures.filter((feature) =>
        [feature.title, feature.description, t(feature.title), t(feature.description)].some(
            (value) => value.toLocaleLowerCase().includes(needle)
        )
    );

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
            <div className={styles.content} tabIndex={0} aria-label={t('Built-in features')}>
                <div className={styles.intro}>
                    <span className={styles.eyebrow}>NIDO / {t('Built-in')}</span>
                    <h2>{t('Discover what Nido can do.')}</h2>
                    <p>{t('Explore the features included with Nido.')}</p>
                </div>
                <div className={styles.toolbar}>
                    <label className={styles.search}>
                        <Search size={17} />
                        <input
                            ref={search}
                            aria-label={t('Search features')}
                            placeholder={t('Search built-in features')}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <span className={styles.count} role="status">
                        {t('Showing {count} of {total}', {
                            count: features.length,
                            total: builtinFeatures.length
                        })}
                    </span>
                </div>
                {featureCategories.map((category) => {
                    const items = features.filter((feature) => feature.category === category.id);
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
                                            <span className={styles.badge}>{t('Built-in')}</span>
                                        </div>
                                        <p>{t(feature.description)}</p>
                                        {feature.shortcut && <kbd>{feature.shortcut}</kbd>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })}
                {!features.length && (
                    <p className={styles.empty}>{t('No features match your search.')}</p>
                )}
            </div>
        </section>
    );
}

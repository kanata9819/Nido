import { useEffect, useState } from 'react';
import { useErrorMessage, useI18n } from '../i18n';
import type { GitHubStatus } from '../../../shared/github';
import styles from '../settings/ExtensionsPage.module.css';

/**
 * The GitHub extension on the Extensions page (Other extensions): a switch to turn it on, and
 * whether the GitHub CLI is installed and signed in for the current workspace.
 */
export default function GitHubExtensionCard({
	workspaceId,
	enabled,
	setEnabled
}: {
	workspaceId?: string;
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [status, setStatus] = useState<GitHubStatus>();
	useEffect(() => {
		if (!enabled || !workspaceId) {
			return;
		}
		let alive = true;
		window.nido.githubStatus(workspaceId).then(
			(next) => alive && setStatus(next),
			(error) =>
				alive &&
				setStatus({ installed: false, authenticated: false, message: String(error) })
		);
		return () => {
			alive = false;
		};
	}, [enabled, workspaceId]);
	const shown = enabled && workspaceId ? status : undefined;
	const badge = !enabled
		? { status: 'disabled', title: 'Disabled' }
		: !shown
			? { status: 'ready', title: 'Enabled' }
			: !shown.installed || !shown.authenticated
				? { status: 'missing', title: 'Setup required' }
				: { status: 'running', title: 'Signed in' };
	return (
		<ul className={styles.grid}>
			<li className={styles.card} data-pack="github">
				<div className={styles.cardHeading}>
					<div>
						<h4>{t('GitHub Pull Requests and Issues')}</h4>
						<code className={styles.extensions}>gh · {t('GitHub CLI')}</code>
					</div>
					<span className={styles.neutralBadge}>{t('Built-in')}</span>
				</div>
				<p>
					{t(
						'Review, comment on, check out, create and merge pull requests, and work with issues, through the GitHub CLI. Open it with Space G.'
					)}
				</p>
				<div className={styles.packControls}>
					<span role="status" className={styles.badge} data-status={badge.status}>
						{t(badge.title)}
					</span>
					<label>
						<input
							type="checkbox"
							checked={enabled}
							aria-label={t('Enable {name}', { name: 'GitHub' })}
							onChange={(event) => setEnabled(event.currentTarget.checked)}
						/>
						{t('Enabled')}
					</label>
				</div>
				{shown?.authenticated && shown.repository && (
					<p>
						{t('Signed in as {user} · {repository}', {
							user: shown.user ?? '',
							repository: shown.repository
						})}
					</p>
				)}
				{shown?.message && (
					<p className={styles.packError}>{errorMessage(shown.message)}</p>
				)}
				{shown && !shown.installed && (
					<code className={styles.installCommand}>winget install --id GitHub.cli</code>
				)}
				{shown?.installed && !shown.authenticated && (
					<code className={styles.installCommand}>gh auth login</code>
				)}
			</li>
		</ul>
	);
}

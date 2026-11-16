import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitPullRequest } from 'lucide-react';
import { useErrorMessage, useI18n } from '../i18n';
import { PanelHeadingSlot } from '../ui/panelHeading';
import { useGitAction } from '../git/browser/useGitAction';
import { useGitBrowserKeyboard } from '../git/useGitBrowserKeyboard';
import type { GitHubStatus } from '../../../shared/github';
import { githubViews, type GitHubView, type GitHubViewProps } from './githubModel';
import PullRequests from './PullRequests';
import Issues from './Issues';
import NewPullRequest from './NewPullRequest';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

/**
 * The GitHub page (Space G): the pull requests and issues of the workspace's repository, and
 * a form to open a pull request from the checked-out branch. It uses the GitHub CLI (gh) and
 * its sign-in; until gh is installed and signed in, it explains how.
 */
export default function GitHubBrowser({
	workspaceId,
	onClose,
	initialView = 'pulls'
}: {
	workspaceId: string;
	onClose: () => void;
	initialView?: GitHubView;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	const [view, setView] = useState<GitHubView>(initialView);
	const [status, setStatus] = useState<GitHubStatus>();
	const [notice, setNotice] = useState('');
	const action = useGitAction();
	const backRef = useRef<() => boolean>(undefined);
	const ready = !!status?.authenticated && !!status.repository;

	const refreshStatus = useCallback(async () => {
		setStatus(await window.nido.githubStatus(workspaceId));
	}, [workspaceId]);
	useEffect(() => {
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
	}, [workspaceId]);

	function changeView(next: GitHubView): void {
		if (action.working || !ready) {
			return;
		}
		setView(next);
		setNotice('');
		action.setError('');
	}

	useGitBrowserKeyboard({
		busy: action.working,
		back: () => {
			if (!backRef.current?.()) {
				onClose();
			}
		},
		changeView,
		panel: 'github',
		views: githubViews
	});

	const heading = useContext(PanelHeadingSlot);
	const tabs = ready && (
		<nav className={gitStyles.viewTabs} aria-label={t('GitHub views')}>
			{githubViews.map((tab, position) => (
				<button
					key={tab}
					disabled={action.working}
					aria-current={view === tab ? 'page' : undefined}
					aria-keyshortcuts={String(position + 1)}
					onClick={() => changeView(tab)}
				>
					{t(viewTitles[tab])}
					<kbd aria-hidden="true">{position + 1}</kbd>
				</button>
			))}
		</nav>
	);

	const props: GitHubViewProps = {
		workspaceId,
		status: status!,
		action,
		notify: setNotice,
		backRef,
		refreshStatus
	};
	return (
		<div className={`${gitStyles.panel} ${styles.page}`}>
			{heading && tabs ? createPortal(tabs, heading) : tabs}
			{!status ? (
				<p className={styles.gate} role="status">
					{t('Connecting to GitHub…')}
				</p>
			) : !ready ? (
				<SignIn status={status} refresh={() => void action.run(refreshStatus)} />
			) : (
				<section aria-label={t('GitHub')} aria-busy={action.working}>
					{view === 'pulls' ? (
						<PullRequests {...props} />
					) : view === 'issues' ? (
						<Issues {...props} />
					) : (
						<NewPullRequest {...props} created={() => setView('pulls')} />
					)}
					{action.error && (
						<p role="alert" className={gitStyles.error}>
							{errorMessage(action.error)}
						</p>
					)}
					{notice && !action.error && (
						<p role="status" className={styles.notice}>
							{t(notice)}
						</p>
					)}
				</section>
			)}
		</div>
	);
}

const viewTitles = {
	pulls: 'Pull requests',
	issues: 'Issues',
	create: 'New pull request'
} as const;

/** Why GitHub cannot be used yet, and how to set gh up. */
function SignIn({
	status,
	refresh
}: {
	status: GitHubStatus;
	refresh: () => void;
}): React.JSX.Element {
	const t = useI18n();
	const errorMessage = useErrorMessage();
	return (
		<div className={styles.gate} data-git-summary tabIndex={0}>
			<GitPullRequest size={34} aria-hidden="true" />
			<h2>
				{t(
					!status.installed
						? 'Install the GitHub CLI'
						: !status.authenticated
							? 'Sign in to GitHub'
							: 'No GitHub repository'
				)}
			</h2>
			<p>
				{t(
					!status.installed
						? 'Nido uses the GitHub CLI (gh) and its sign-in. Install it, run gh auth login in a terminal, then refresh.'
						: !status.authenticated
							? 'Run gh auth login in a terminal, then refresh.'
							: 'This workspace has no Git remote on GitHub.'
				)}
			</p>
			{status.message && status.installed && status.authenticated && (
				<p className={styles.dim}>{errorMessage(status.message)}</p>
			)}
			{!status.installed && <code>winget install --id GitHub.cli</code>}
			{status.installed && !status.authenticated && <code>gh auth login</code>}
			<button onClick={refresh}>{t('Refresh')}</button>
		</div>
	);
}

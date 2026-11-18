import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { GitHubViewProps } from './githubModel';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

/**
 * Open a pull request from the checked-out branch: its title (the last commit's subject at
 * first), description, base branch and whether it is a draft. The branch is pushed first.
 */
export default function NewPullRequest({
	workspaceId,
	status,
	action,
	notify,
	backRef,
	keysRef,
	created
}: GitHubViewProps & { created: () => void }): React.JSX.Element {
	const t = useI18n();
	const { run, working } = action;
	const [titleDraft, setTitleDraft] = useState<string>();
	const title = titleDraft ?? '';
	const [body, setBody] = useState('');
	const [base, setBase] = useState(status.defaultBranch ?? 'main');
	const [draft, setDraft] = useState(false);
	const titleInput = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		backRef.current = () => false;
		keysRef.current = undefined;
	});

	// Start from the last commit's subject only if the title has never been edited.
	useEffect(() => {
		let alive = true;
		window.nido.gitHistory(workspaceId, 0).then(
			({ commits }) => {
				if (alive && commits[0]) {
					setTitleDraft((value) => value ?? commits[0].subject);
				}
			},
			() => {}
		);
		titleInput.current?.focus();
		return () => {
			alive = false;
		};
	}, [workspaceId]);

	const branch = status.branch;
	const sameBranch = !!branch && branch === base.trim();
	const canCreate = !working && !!branch && !sameBranch && !!title.trim() && !!base.trim();
	const create = (): void => {
		if (!canCreate) {
			return;
		}
		void run(async () => {
			const url = await window.nido.githubCreatePullRequest(
				workspaceId,
				title,
				body,
				base.trim(),
				draft
			);
			notify(url ? t('Pull request created: {url}', { url }) : 'Pull request created.');
			created();
		});
	};

	return (
		<>
			<div className={gitStyles.toolbar}>
				<strong>{status.repository}</strong>
				<span>
					{branch
						? t('From {head} into {base}', { head: branch, base: base || '…' })
						: t('Check out a branch first.')}
				</span>
			</div>
			<form
				className={styles.newPullRequest}
				aria-label={t('New pull request')}
				onSubmit={(event) => {
					event.preventDefault();
					create();
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						create();
					}
				}}
			>
				<label>
					{t('Title')}
					<input
						ref={titleInput}
						value={title}
						onChange={(event) => setTitleDraft(event.currentTarget.value)}
					/>
				</label>
				<label className={styles.grow}>
					{t('Description')}
					<textarea
						value={body}
						placeholder={t('Describe the change (Markdown)')}
						onChange={(event) => setBody(event.currentTarget.value)}
					/>
				</label>
				<div className={styles.composerControls}>
					<label className={styles.filter}>
						{t('Base branch')}
						<input
							className={styles.branchInput}
							value={base}
							onChange={(event) => setBase(event.currentTarget.value)}
						/>
					</label>
					<label className={styles.check}>
						<input
							type="checkbox"
							checked={draft}
							onChange={(event) => setDraft(event.currentTarget.checked)}
						/>
						{t('Draft')}
					</label>
					<span />
					{sameBranch && (
						<small className={styles.removed}>
							{t('Switch to a branch other than the base first.')}
						</small>
					)}
					<button type="submit" className={styles.primary} disabled={!canCreate}>
						{t('Push and create pull request')} <kbd>Ctrl+Enter</kbd>
					</button>
				</div>
			</form>
			<footer>
				{t('1/2/3 Views · Tab Move between fields · Ctrl+Enter Create · Esc Close')}
			</footer>
		</>
	);
}

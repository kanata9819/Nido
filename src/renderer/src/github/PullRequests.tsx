import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type {
	PullRequestDetails,
	PullRequestFilter,
	PullRequestSummary
} from '../../../shared/github';
import GitHubList, { type GitHubRow } from './GitHubList';
import { ChecksIcon, PullRequestState } from './format';
import PullRequestOverview, { type PullRequestForm } from './PullRequestOverview';
import PullRequestFile from './PullRequestFile';
import { PullRequestCard } from './PullRequestCard';
import type { GitHubViewProps } from './githubModel';
import gitStyles from '../git/Git.module.css';
import styles from './GitHub.module.css';

const filters: readonly PullRequestFilter[] = ['open', 'mine', 'review', 'closed'];
const filterTitles = {
	open: 'Open',
	mine: 'Created by me',
	review: 'Review requested',
	closed: 'Closed'
} as const;

/**
 * The pull requests of the repository. Enter opens one: the list then holds its overview and
 * changed files, and the preview shows the overview, or a file's diff with its review threads.
 */
export default function PullRequests({
	workspaceId,
	status,
	action,
	notify,
	backRef,
	keysRef,
	refreshStatus
}: GitHubViewProps): React.JSX.Element {
	const t = useI18n();
	const { run, working } = action;
	const [filter, setFilter] = useState<PullRequestFilter>('open');
	const [revision, setRevision] = useState(0);
	const [prs, setPrs] = useState<PullRequestSummary[]>([]);
	// The filter and refresh count the shown list was loaded for.
	const [loadedKey, setLoadedKey] = useState<string>();
	const listKey = `${filter}:${revision}`;
	const loaded = loadedKey === listKey;
	const [index, setIndex] = useState(0);
	// The opened pull request, its diff per file, and the entry selected in it (0: overview).
	const [opened, setOpened] = useState<PullRequestDetails>();
	const [diffs, setDiffs] = useState<Map<string, string>>();
	const [entry, setEntry] = useState(0);
	const [form, setForm] = useState<PullRequestForm>();
	const list = useRef<HTMLDivElement>(null);
	const busy = working || !loaded;

	useEffect(() => {
		let alive = true;
		window.nido.githubPullRequests(workspaceId, filter).then(
			(next) => {
				if (alive) {
					setPrs(next);
					setIndex((value) => Math.min(value, Math.max(0, next.length - 1)));
					setLoadedKey(listKey);
					list.current?.focus();
				}
			},
			(error) => {
				if (alive) {
					setPrs([]);
					setLoadedKey(listKey);
					action.setError(String(error));
				}
			}
		);
		return () => {
			alive = false;
		};
		// The error setter is stable; listing again only follows the filter and refreshes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaceId, filter, revision, listKey]);

	/** Keep the same file across reloads, even when it moves to another row. */
	function showDetails(details: PullRequestDetails, keepEntry: boolean): void {
		setOpened(details);
		setEntry((value) => {
			const path = keepEntry ? opened?.files[value - 1]?.path : undefined;
			return path ? details.files.findIndex((file) => file.path === path) + 1 : 0;
		});
	}

	/** Load (or reload) a pull request with its diff. */
	function open(number: number, keepEntry = false): Promise<boolean> {
		return run(async () => {
			const [details, files] = await Promise.all([
				window.nido.githubPullRequest(workspaceId, number),
				window.nido.githubPullRequestDiff(workspaceId, number)
			]);
			showDetails(details, keepEntry);
			setDiffs(new Map(files));
			list.current?.focus();
		});
	}

	function close(): void {
		setOpened(undefined);
		setDiffs(undefined);
		setForm(undefined);
		setEntry(0);
		list.current?.focus();
	}

	useLayoutEffect(() => {
		backRef.current = () => {
			if (form) {
				setForm(undefined);
				list.current?.focus();
				return true;
			}
			if (opened) {
				close();
				return true;
			}
			return false;
		};
	});

	const selected = opened ?? prs[index];
	const openInBrowser = (): void => {
		if (selected?.url) {
			void window.nido.openDocumentation(selected.url);
		}
	};
	/**
	 * Run a pull request action, then reload it and the list behind it, and confirm with
	 * `message`, or with the text the action returns instead.
	 */
	const act = (change: () => Promise<unknown>, message: string): Promise<boolean> =>
		run(async () => {
			const note = await change();
			setForm(undefined);
			if (opened) {
				const details = await window.nido.githubPullRequest(workspaceId, opened.number);
				showDetails(details, true);
			}
			// A merge, review or checkout changes the PR's state, checks or review in the list.
			setRevision((value) => value + 1);
			notify(typeof note === 'string' ? note : message);
			list.current?.focus();
		});
	const checkout = (): void => {
		if (opened) {
			void act(async () => {
				await window.nido.githubCheckout(workspaceId, opened.number);
				await refreshStatus();
			}, 'Checked out the pull request’s branch.');
		}
	};

	const rows: GitHubRow[] = opened
		? [
				{ key: 'overview', title: t('Overview'), label: t('Overview') },
				...opened.files.map((file) => ({
					key: file.path,
					title: file.path.slice(file.path.lastIndexOf('/') + 1),
					label: file.path,
					meta: (
						<>
							<span className={styles.added}>+{file.additions}</span>
							<span className={styles.removed}>−{file.deletions}</span>
							<small className={styles.folder}>
								<bdi>
									{file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))}
								</bdi>
							</small>
						</>
					)
				}))
			]
		: prs.map((pr) => ({
				key: String(pr.number),
				title: pr.title,
				label: `#${pr.number} ${pr.title}`,
				meta: (
					<>
						<code className={gitStyles.hashBadge}>#{pr.number}</code>
						<PullRequestState pr={pr} />
						<ChecksIcon state={pr.checks} />
						<span>{pr.author}</span>
					</>
				)
			}));

	const keys: Record<string, () => void> = opened
		? {
				o: checkout,
				c: () => setForm('comment'),
				v: () => setForm('review'),
				m: () => setForm('merge'),
				b: openInBrowser,
				r: () => void open(opened.number, true)
			}
		: {
				f: () => setFilter(filters[(filters.indexOf(filter) + 1) % filters.length]),
				b: openInBrowser,
				r: () => setRevision((value) => value + 1)
			};
	useLayoutEffect(() => {
		keysRef.current = keys;
	});

	const file = opened && entry > 0 ? opened.files[entry - 1] : undefined;
	return (
		<>
			<div className={gitStyles.toolbar}>
				<strong>{status.repository}</strong>
				<span>
					{opened
						? t('#{number} · {title}', { number: opened.number, title: opened.title })
						: t('Branch: {branch}', { branch: status.branch ?? '—' })}
				</span>
				{opened ? (
					<button disabled={working} onClick={close}>
						{t('Back (Esc)')}
					</button>
				) : (
					<label className={styles.filter}>
						{t('Show')}
						<select
							value={filter}
							disabled={busy}
							aria-keyshortcuts="f"
							onChange={(event) =>
								setFilter(event.currentTarget.value as PullRequestFilter)
							}
						>
							{filters.map((value) => (
								<option key={value} value={value}>
									{t(filterTitles[value])}
								</option>
							))}
						</select>
					</label>
				)}
				<button
					disabled={busy}
					onClick={() =>
						opened ? void open(opened.number, true) : setRevision((value) => value + 1)
					}
				>
					{t('Refresh (r)')}
				</button>
			</div>
			<div className={gitStyles.content}>
				<GitHubList
					rows={rows}
					label={opened ? t('Pull request files') : t('Pull requests')}
					busy={busy}
					index={opened ? entry : index}
					setIndex={opened ? setEntry : setIndex}
					listRef={list}
					open={() => {
						if (!opened && prs[index]) {
							void open(prs[index].number);
						} else if (opened) {
							// Enter moves into the overview or the file's diff.
							document
								.querySelector<HTMLElement>(
									entry > 0
										? '[data-panel="github"] [data-git-scroll="after"]'
										: '[data-panel="github"] [data-git-summary]'
								)
								?.focus();
						}
					}}
					empty={t(loaded ? 'No pull requests.' : 'Loading…')}
				/>
				<div className={`${gitStyles.preview} ${styles.preview}`} data-git-preview>
					{opened && file ? (
						<PullRequestFile
							key={`${opened.number}:${file.path}`}
							workspaceId={workspaceId}
							pr={opened}
							path={file.path}
							diff={diffs?.get(file.path) ?? ''}
							busy={working}
							commenting={form === 'comment'}
							setCommenting={(value) => setForm(value ? 'comment' : undefined)}
							act={act}
						/>
					) : opened ? (
						<PullRequestOverview
							workspaceId={workspaceId}
							pr={opened}
							busy={working}
							form={form}
							setForm={setForm}
							act={act}
							checkout={checkout}
							openInBrowser={openInBrowser}
						/>
					) : prs[index] ? (
						<PullRequestCard
							pr={prs[index]}
							busy={busy}
							open={() => void open(prs[index].number)}
						/>
					) : (
						<div className={gitStyles.emptyPreview} tabIndex={0} aria-busy={busy}>
							{!busy && <p>{t('Nothing to preview yet.')}</p>}
						</div>
					)}
				</div>
			</div>
			<footer>
				{t(
					opened
						? '1/2/3 Views · j/k Select · Enter Diff · o Check out · c Comment · v Review · m Merge · b Browser · r Refresh · Esc Back'
						: '1/2/3 Views · j/k Select · Enter Open · f Filter · b Browser · r Refresh · Ctrl+H/L List / Preview · Esc Close'
				)}
			</footer>
		</>
	);
}

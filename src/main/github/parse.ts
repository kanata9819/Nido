import type {
	CheckState,
	GitHubComment,
	IssueDetails,
	IssueSummary,
	PullRequestCheck,
	PullRequestDetails,
	PullRequestSummary,
	ReviewThread
} from '../../shared/github';

// Turn gh's JSON into the shapes the renderer shows. gh's fields follow GitHub's GraphQL API;
// anything missing or of the wrong type becomes an empty value rather than an error.

type Json = Record<string, unknown>;

const object = (value: unknown): Json =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const login = (value: unknown): string => text(object(value).login) || 'ghost';
const labels = (value: unknown): string[] =>
	list(value)
		.map((label) => text(object(label).name))
		.filter(Boolean);

/** One entry of statusCheckRollup: a check run (Actions) or a commit status. */
export function parseCheck(value: unknown): PullRequestCheck {
	const entry = object(value);
	if (entry.__typename === 'StatusContext' || 'context' in entry) {
		const state = text(entry.state);
		return {
			name: text(entry.context),
			state:
				state === 'SUCCESS'
					? 'success'
					: state === 'FAILURE' || state === 'ERROR'
						? 'failure'
						: 'pending',
			url: text(entry.targetUrl) || undefined
		};
	}
	const status = text(entry.status);
	const conclusion = text(entry.conclusion);
	let state: PullRequestCheck['state'] = 'pending';
	if (status === 'COMPLETED') {
		state =
			conclusion === 'SUCCESS'
				? 'success'
				: conclusion === 'SKIPPED'
					? 'skipped'
					: conclusion === 'NEUTRAL'
						? 'neutral'
						: 'failure';
	}
	return {
		name: text(entry.name) || text(entry.workflowName),
		state,
		url: text(entry.detailsUrl) || undefined
	};
}

/** All checks together: failing if any failed, pending if any still runs. */
export function combinedChecks(checks: PullRequestCheck[]): CheckState {
	if (!checks.length) {
		return 'none';
	}
	if (checks.some((check) => check.state === 'failure')) {
		return 'failure';
	}
	return checks.some((check) => check.state === 'pending') ? 'pending' : 'success';
}

export function parsePullRequestSummary(value: unknown): PullRequestSummary {
	const pr = object(value);
	const state = text(pr.state);
	return {
		number: count(pr.number),
		title: text(pr.title),
		author: login(pr.author),
		state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
		isDraft: pr.isDraft === true,
		headRefName: text(pr.headRefName),
		baseRefName: text(pr.baseRefName),
		reviewDecision: text(pr.reviewDecision),
		checks: combinedChecks(list(pr.statusCheckRollup).map(parseCheck)),
		updatedAt: text(pr.updatedAt),
		url: text(pr.url),
		labels: labels(pr.labels)
	};
}

function parseComment(value: unknown): GitHubComment {
	const comment = object(value);
	return {
		id: text(comment.id) || String(count(comment.databaseId)),
		author: login(comment.author),
		body: text(comment.body),
		createdAt: text(comment.createdAt) || text(comment.submittedAt),
		url: text(comment.url) || undefined
	};
}

/** The conversation's comments and reviews that have text or a verdict, oldest first. */
function timeline(comments: unknown, reviews: unknown): GitHubComment[] {
	const entries = list(comments).map(parseComment);
	for (const value of list(reviews)) {
		const review = object(value);
		const state = text(review.state);
		// A review with no text and only line comments shows in the file's threads instead.
		if (!text(review.body) && state === 'COMMENTED') {
			continue;
		}
		entries.push({ ...parseComment(review), reviewState: state || undefined });
	}
	return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The review threads of a pull request, from the GraphQL query in github.ts. */
export function parseReviewThreads(value: unknown): ReviewThread[] {
	const threads = object(
		object(object(object(value).repository).pullRequest).reviewThreads
	).nodes;
	return list(threads).map((node) => {
		const thread = object(node);
		const line = thread.line ?? thread.originalLine;
		return {
			id: text(thread.id),
			path: text(thread.path),
			line: typeof line === 'number' ? line : undefined,
			side: thread.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
			isResolved: thread.isResolved === true,
			isOutdated: thread.isOutdated === true,
			comments: list(object(thread.comments).nodes).map(parseComment)
		};
	});
}

export function parsePullRequestDetails(value: unknown, threads: unknown): PullRequestDetails {
	const pr = object(value);
	const checkRuns = list(pr.statusCheckRollup).map(parseCheck);
	return {
		...parsePullRequestSummary(pr),
		body: text(pr.body),
		headRefOid: text(pr.headRefOid),
		isCrossRepository: pr.isCrossRepository === true,
		mergeable: text(pr.mergeable) || 'UNKNOWN',
		additions: count(pr.additions),
		deletions: count(pr.deletions),
		createdAt: text(pr.createdAt),
		files: list(pr.files).map((file) => ({
			path: text(object(file).path),
			additions: count(object(file).additions),
			deletions: count(object(file).deletions)
		})),
		checkRuns,
		timeline: timeline(pr.comments, pr.reviews),
		threads: parseReviewThreads(threads)
	};
}

export function parseIssueSummary(value: unknown): IssueSummary {
	const issue = object(value);
	const comments = issue.comments;
	return {
		number: count(issue.number),
		title: text(issue.title),
		author: login(issue.author),
		state: text(issue.state) === 'CLOSED' ? 'CLOSED' : 'OPEN',
		updatedAt: text(issue.updatedAt),
		url: text(issue.url),
		labels: labels(issue.labels),
		comments: Array.isArray(comments) ? comments.length : count(object(comments).totalCount)
	};
}

export function parseIssueDetails(value: unknown): IssueDetails {
	const issue = object(value);
	return {
		...parseIssueSummary(issue),
		body: text(issue.body),
		createdAt: text(issue.createdAt),
		assignees: list(issue.assignees).map(login),
		timeline: list(issue.comments).map(parseComment)
	};
}

/**
 * A path as git writes it in a diff header, without its a/ or b/ prefix (`prefixed`). Git quotes a path with
 * unusual characters ("b/\346\227\245.ts" for 日.ts, octal UTF-8 bytes) and ends a ---/+++ path
 * that has spaces with a tab.
 */
export function diffPath(raw: string, prefixed = true): string {
	let path = raw.replace(/\t$/, '');
	if (path.startsWith('"') && path.endsWith('"')) {
		const bytes: number[] = [];
		const escapes: Record<string, number> = {
			n: 10,
			t: 9,
			'"': 34,
			'\\': 92,
			a: 7,
			b: 8,
			f: 12,
			r: 13,
			v: 11
		};
		const inner = path.slice(1, -1);
		for (let i = 0; i < inner.length; i++) {
			const char = inner[i];
			if (char !== '\\') {
				bytes.push(...Buffer.from(char, 'utf8'));
				continue;
			}
			const octal = inner.slice(i + 1, i + 4);
			if (/^[0-7]{3}$/.test(octal)) {
				bytes.push(parseInt(octal, 8));
				i += 3;
			} else {
				bytes.push(escapes[inner[i + 1]] ?? inner.charCodeAt(i + 1));
				i += 1;
			}
		}
		path = Buffer.from(bytes).toString('utf8');
	}
	return prefixed ? path.replace(/^[ab]\//, '') : path;
}

/**
 * Split the unified diff of a whole pull request (`gh pr diff`) into one diff per file, keyed
 * by the file's path in the new version, or in the old one for a deleted file.
 */
export function splitPullRequestDiff(diff: string): Map<string, string> {
	const files = new Map<string, string>();
	const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '));
	for (const part of parts) {
		// Only the header, before the first hunk, names the file; added lines can look alike.
		const header = part.split(/^@@ /m)[0];
		const newPath = header.match(/^\+\+\+ ("?b\/.*)$/m)?.[1];
		const oldPath = header.match(/^--- ("?a\/.*)$/m)?.[1];
		const renamed = header.match(/^rename to (.*)$/m)?.[1];
		// Without ---/+++ lines (a binary file or a pure rename), the first line names the file.
		const named = header.match(/^diff --git (?:"a\/.*" ("b\/.*")|a\/.* (b\/.*))$/m);
		const raw = newPath ?? oldPath ?? named?.[1] ?? named?.[2];
		const path =
			newPath === undefined && renamed ? diffPath(renamed, false) : raw && diffPath(raw);
		if (path) {
			files.set(path, part.endsWith('\n') ? part : `${part}\n`);
		}
	}
	return files;
}

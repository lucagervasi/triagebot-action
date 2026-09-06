/**
 * The forge abstraction.
 *
 * `ForgeClient` is the only place that knows how to talk to a specific code
 * host. Every method takes an explicit token so the caller keeps control over
 * whether a read or a write token is used — the LLM agent never sees the
 * write token.
 */

import * as v from 'valibot';
import {
	type CreatePullRequestOptions,
	DEFAULT_LABEL_PATTERNS,
	type IssueDetails,
	issueDetailsSchema,
	type LabelPatterns,
	type PullRequest,
	type RepoLabel,
} from './types.ts';

export type ForgeKind = 'github' | 'gitea';

export interface ForgeConfig {
	kind: ForgeKind;
	/** `owner/repo`. */
	repo: string;
	/** Web base URL, no trailing slash (e.g. `https://gitea.example.com`). */
	serverUrl: string;
	/** REST API base URL, no trailing slash. */
	apiUrl: string;
	labelPatterns?: LabelPatterns;
}

export interface ForgeClient {
	readonly kind: ForgeKind;
	readonly repo: string;
	readonly serverUrl: string;
	readonly apiUrl: string;

	fetchIssueDetails(issueNumber: number, token: string): Promise<IssueDetails>;
	fetchRepoLabels(
		token: string,
	): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }>;
	addLabels(issueNumber: number, labels: string[], token: string): Promise<void>;
	removeLabel(issueNumber: number, label: string, token: string): Promise<void>;
	swapLabel(
		issueNumber: number,
		oldLabel: string | null,
		newLabel: string,
		token: string,
	): Promise<void>;
	postComment(issueNumber: number, body: string, token: string): Promise<void>;
	createPullRequest(options: CreatePullRequestOptions, token: string): Promise<PullRequest>;
	findPullRequest(head: string, token: string): Promise<PullRequest | null>;
	findBranch(branches: string[], token: string): Promise<string | null>;
	deleteBranch(branch: string, token: string): Promise<void>;

	/** Authenticated https remote suitable for `git push`. Contains a secret. */
	remoteUrl(token: string): string;
	/** Web URL a maintainer can open to review `branch` against `baseBranch`. */
	compareUrl(branch: string, baseBranch: string): string;
	/** Web URL of the CI run currently executing, or null when unknown. */
	runUrl(runId: string): string;
}

/**
 * Shared plumbing for the GitHub-family REST APIs (GitHub and Gitea both
 * accept `Authorization: token <t>` and speak JSON over the same verbs).
 */
export abstract class BaseForge implements ForgeClient {
	readonly kind: ForgeKind;
	readonly repo: string;
	readonly serverUrl: string;
	readonly apiUrl: string;
	protected readonly labelPatterns: LabelPatterns;

	constructor(config: ForgeConfig) {
		this.kind = config.kind;
		this.repo = config.repo;
		this.serverUrl = config.serverUrl.replace(/\/+$/, '');
		this.apiUrl = config.apiUrl.replace(/\/+$/, '');
		this.labelPatterns = config.labelPatterns ?? DEFAULT_LABEL_PATTERNS;
	}

	protected headers(token: string): Record<string, string> {
		return {
			Authorization: `token ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
	}

	/** Perform a request and throw a descriptive error on any non-ok status. */
	protected async request(
		path: string,
		token: string,
		init: RequestInit & { description: string },
	): Promise<Response> {
		const { description, ...rest } = init;
		const res = await fetch(`${this.apiUrl}${path}`, {
			...rest,
			headers: { ...this.headers(token), ...(rest.headers as Record<string, string>) },
		});
		if (!res.ok) {
			throw new Error(`${description} (HTTP ${res.status}): ${await res.text()}`);
		}
		return res;
	}

	/** Like `request`, but returns null instead of throwing on the given statuses. */
	protected async requestTolerating(
		path: string,
		token: string,
		tolerated: number[],
		init: RequestInit & { description: string },
	): Promise<Response | null> {
		const { description, ...rest } = init;
		const res = await fetch(`${this.apiUrl}${path}`, {
			...rest,
			headers: { ...this.headers(token), ...(rest.headers as Record<string, string>) },
		});
		if (tolerated.includes(res.status)) return null;
		if (!res.ok) {
			throw new Error(`${description} (HTTP ${res.status}): ${await res.text()}`);
		}
		return res;
	}

	protected splitLabels(all: RepoLabel[]): {
		priorityLabels: RepoLabel[];
		packageLabels: RepoLabel[];
	} {
		return {
			priorityLabels: all.filter((l) => this.labelPatterns.priority.test(l.name)),
			packageLabels: all.filter((l) => this.labelPatterns.package.test(l.name)),
		};
	}

	protected parseIssue(raw: {
		issue: Record<string, unknown>;
		comments: Record<string, unknown>[];
	}): IssueDetails {
		const { issue, comments } = raw;
		return v.parse(issueDetailsSchema, {
			title: issue.title,
			body: issue.body ?? '',
			author: { login: (issue.user as Record<string, unknown>)?.login },
			labels: issue.labels,
			createdAt: issue.created_at,
			state: issue.state,
			number: issue.number,
			url: issue.html_url,
			comments: comments.map((c) => ({
				author: { login: (c.user as Record<string, unknown>)?.login },
				// Gitea has no author_association; downstream prompts treat the
				// absence as an unknown relationship rather than failing to parse.
				authorAssociation: c.author_association ?? 'NONE',
				body: c.body ?? '',
				createdAt: c.created_at,
			})),
		});
	}

	/** Atomically swap one triage label for another. */
	async swapLabel(
		issueNumber: number,
		oldLabel: string | null,
		newLabel: string,
		token: string,
	): Promise<void> {
		if (oldLabel) {
			await this.removeLabel(issueNumber, oldLabel, token);
		}
		await this.addLabels(issueNumber, [newLabel], token);
	}

	runUrl(runId: string): string {
		return `${this.serverUrl}/${this.repo}/actions/runs/${runId}`;
	}

	abstract fetchIssueDetails(issueNumber: number, token: string): Promise<IssueDetails>;
	abstract fetchRepoLabels(
		token: string,
	): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }>;
	abstract addLabels(issueNumber: number, labels: string[], token: string): Promise<void>;
	abstract removeLabel(issueNumber: number, label: string, token: string): Promise<void>;
	abstract postComment(issueNumber: number, body: string, token: string): Promise<void>;
	abstract createPullRequest(
		options: CreatePullRequestOptions,
		token: string,
	): Promise<PullRequest>;
	abstract findPullRequest(head: string, token: string): Promise<PullRequest | null>;
	abstract findBranch(branches: string[], token: string): Promise<string | null>;
	abstract deleteBranch(branch: string, token: string): Promise<void>;
	abstract remoteUrl(token: string): string;
	abstract compareUrl(branch: string, baseBranch: string): string;
}

/**
 * GitHub forge adapter. Also covers GitHub Enterprise Server, which uses the
 * same REST surface under `<server>/api/v3`.
 */

import * as v from 'valibot';
import { BaseForge, type ForgeConfig } from './client.ts';
import {
	type CreatePullRequestOptions,
	type IssueDetails,
	type PullRequest,
	type RepoLabel,
	repoLabelSchema,
} from './types.ts';

export class GitHubForge extends BaseForge {
	constructor(config: Omit<ForgeConfig, 'kind'>) {
		super({ ...config, kind: 'github' });
	}

	protected override headers(token: string): Record<string, string> {
		return {
			Authorization: `token ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/vnd.github+json',
		};
	}

	async fetchIssueDetails(issueNumber: number, token: string): Promise<IssueDetails> {
		const [issueRes, commentsRes] = await Promise.all([
			this.request(`/repos/${this.repo}/issues/${issueNumber}`, token, {
				description: `Failed to fetch issue ${issueNumber}`,
			}),
			this.request(`/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`, token, {
				description: `Failed to fetch comments for issue ${issueNumber}`,
			}),
		]);

		return this.parseIssue({
			issue: (await issueRes.json()) as Record<string, unknown>,
			comments: (await commentsRes.json()) as Record<string, unknown>[],
		});
	}

	async fetchRepoLabels(
		token: string,
	): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }> {
		const all: RepoLabel[] = [];
		let page = 1;
		while (true) {
			const res = await this.request(
				`/repos/${this.repo}/labels?per_page=100&page=${page}`,
				token,
				{
					description: 'Failed to fetch labels',
				},
			);
			const batch = v.parse(v.array(repoLabelSchema), await res.json());
			all.push(...batch);
			if (batch.length < 100) break;
			page++;
		}
		return this.splitLabels(all);
	}

	async addLabels(issueNumber: number, labels: string[], token: string): Promise<void> {
		await this.request(`/repos/${this.repo}/issues/${issueNumber}/labels`, token, {
			method: 'POST',
			body: JSON.stringify({ labels }),
			description: 'Failed to add labels',
		});
	}

	async removeLabel(issueNumber: number, label: string, token: string): Promise<void> {
		await this.requestTolerating(
			`/repos/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
			token,
			[404],
			{ method: 'DELETE', description: 'Failed to remove label' },
		);
	}

	async postComment(issueNumber: number, body: string, token: string): Promise<void> {
		await this.request(`/repos/${this.repo}/issues/${issueNumber}/comments`, token, {
			method: 'POST',
			body: JSON.stringify({ body }),
			description: 'Failed to post comment',
		});
	}

	async createPullRequest(options: CreatePullRequestOptions, token: string): Promise<PullRequest> {
		const res = await this.request(`/repos/${this.repo}/pulls`, token, {
			method: 'POST',
			body: JSON.stringify(options),
			description: 'Failed to create pull request',
		});
		return (await res.json()) as PullRequest;
	}

	async findPullRequest(head: string, token: string): Promise<PullRequest | null> {
		const owner = this.repo.split('/')[0];
		const res = await this.request(
			`/repos/${this.repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
			token,
			{ description: 'Failed to check for existing PR' },
		);
		const pulls = await res.json();
		if (!Array.isArray(pulls)) return null;
		return (pulls[0] as PullRequest) ?? null;
	}

	async findBranch(branches: string[], token: string): Promise<string | null> {
		for (const branch of branches) {
			const branchPath = branch.split('/').map(encodeURIComponent).join('/');
			const res = await this.request(
				`/repos/${this.repo}/git/matching-refs/heads/${branchPath}`,
				token,
				{ description: `Failed to check branch ${branch}` },
			);
			const refs = (await res.json()) as Array<{ ref?: string }>;
			if (refs.some((ref) => ref.ref === `refs/heads/${branch}`)) {
				return branch;
			}
		}
		return null;
	}

	async deleteBranch(branch: string, token: string): Promise<void> {
		// 422 = ref doesn't exist, which is fine.
		await this.requestTolerating(
			`/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
			token,
			[422],
			{ method: 'DELETE', description: 'Failed to delete branch' },
		);
	}

	remoteUrl(token: string): string {
		const url = new URL(`${this.serverUrl}/${this.repo}.git`);
		url.username = 'x-access-token';
		url.password = token;
		return url.toString();
	}

	compareUrl(branch: string, _baseBranch: string): string {
		return `${this.serverUrl}/${this.repo}/compare/${branch}?expand=1`;
	}
}

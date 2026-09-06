/**
 * Gitea forge adapter (`<server>/api/v1`).
 *
 * Gitea's REST API is modelled on GitHub's but diverges in four places that
 * matter to this action. Each divergence is handled in the way that also works
 * on instances where Gitea has since caught up, so the adapter is correct on
 * every Gitea version rather than only on recent ones:
 *
 * 1. Issue labels are addressed by numeric **id**, not by name. We resolve
 *    names to ids against the repo's label list.
 * 2. `POST /issues/{index}/labels` does not create labels that don't exist yet
 *    (GitHub does). We create missing ones first, so a fresh repo doesn't need
 *    the ten triage labels seeded by hand.
 * 3. `GET /pulls` has no `head` filter, so we list open PRs and match on
 *    `head.ref` client-side.
 * 4. There is no `git/matching-refs` endpoint; branch existence comes from
 *    `GET /branches/{branch}`.
 *
 * Comments also carry no `author_association`, which the base adapter defaults
 * to `NONE` during normalization.
 */

import * as v from 'valibot';
import { BaseForge, type ForgeConfig } from './client.ts';
import type { CreatePullRequestOptions, IssueDetails, PullRequest, RepoLabel } from './types.ts';

/** Gitea labels expose the numeric id the issue-label routes require. */
const giteaLabelSchema = v.object({
	id: v.number(),
	name: v.string(),
	description: v.nullish(v.string()),
});
type GiteaLabel = v.InferOutput<typeof giteaLabelSchema>;

const PAGE_SIZE = 100;

/** Neutral grey, only used for labels this action has to create itself. */
const CREATED_LABEL_COLOR = 'ededed';

export class GiteaForge extends BaseForge {
	/** Repo label list, cached for the lifetime of one action run. */
	private labelCache: GiteaLabel[] | null = null;

	constructor(config: Omit<ForgeConfig, 'kind'>) {
		super({ ...config, kind: 'gitea' });
	}

	// ---------- Issues ----------

	async fetchIssueDetails(issueNumber: number, token: string): Promise<IssueDetails> {
		const issueRes = await this.request(`/repos/${this.repo}/issues/${issueNumber}`, token, {
			description: `Failed to fetch issue ${issueNumber}`,
		});
		const issue = (await issueRes.json()) as Record<string, unknown>;

		const comments: Record<string, unknown>[] = [];
		let page = 1;
		while (true) {
			const res = await this.request(
				`/repos/${this.repo}/issues/${issueNumber}/comments?limit=${PAGE_SIZE}&page=${page}`,
				token,
				{ description: `Failed to fetch comments for issue ${issueNumber}` },
			);
			const batch = (await res.json()) as Record<string, unknown>[];
			if (!Array.isArray(batch)) break;
			comments.push(...batch);
			if (batch.length < PAGE_SIZE) break;
			page++;
		}

		return this.parseIssue({ issue, comments });
	}

	async postComment(issueNumber: number, body: string, token: string): Promise<void> {
		await this.request(`/repos/${this.repo}/issues/${issueNumber}/comments`, token, {
			method: 'POST',
			body: JSON.stringify({ body }),
			description: 'Failed to post comment',
		});
	}

	// ---------- Labels ----------

	private async listLabels(token: string): Promise<GiteaLabel[]> {
		if (this.labelCache) return this.labelCache;

		const all: GiteaLabel[] = [];
		let page = 1;
		while (true) {
			const res = await this.request(
				`/repos/${this.repo}/labels?limit=${PAGE_SIZE}&page=${page}`,
				token,
				{ description: 'Failed to fetch labels' },
			);
			const batch = v.parse(v.array(giteaLabelSchema), await res.json());
			all.push(...batch);
			if (batch.length < PAGE_SIZE) break;
			page++;
		}

		this.labelCache = all;
		return all;
	}

	private async createLabel(name: string, token: string): Promise<GiteaLabel> {
		const res = await this.request(`/repos/${this.repo}/labels`, token, {
			method: 'POST',
			body: JSON.stringify({ name, color: CREATED_LABEL_COLOR, description: '' }),
			description: `Failed to create label "${name}"`,
		});
		const created = v.parse(giteaLabelSchema, await res.json());
		this.labelCache = [...(this.labelCache ?? []), created];
		return created;
	}

	async fetchRepoLabels(
		token: string,
	): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }> {
		const all = await this.listLabels(token);
		return this.splitLabels(all.map((l) => ({ name: l.name, description: l.description ?? null })));
	}

	async addLabels(issueNumber: number, labels: string[], token: string): Promise<void> {
		if (labels.length === 0) return;

		const existing = await this.listLabels(token);
		const ids: number[] = [];
		for (const name of labels) {
			const match = existing.find((l) => l.name === name);
			ids.push(match ? match.id : (await this.createLabel(name, token)).id);
		}

		await this.request(`/repos/${this.repo}/issues/${issueNumber}/labels`, token, {
			method: 'POST',
			body: JSON.stringify({ labels: ids }),
			description: 'Failed to add labels',
		});
	}

	async removeLabel(issueNumber: number, label: string, token: string): Promise<void> {
		const match = (await this.listLabels(token)).find((l) => l.name === label);
		// A label that does not exist in the repo cannot be on the issue.
		if (!match) return;

		await this.requestTolerating(
			`/repos/${this.repo}/issues/${issueNumber}/labels/${match.id}`,
			token,
			[404],
			{ method: 'DELETE', description: 'Failed to remove label' },
		);
	}

	// ---------- Pull requests ----------

	async createPullRequest(options: CreatePullRequestOptions, token: string): Promise<PullRequest> {
		const res = await this.request(`/repos/${this.repo}/pulls`, token, {
			method: 'POST',
			body: JSON.stringify(options),
			description: 'Failed to create pull request',
		});
		return (await res.json()) as PullRequest;
	}

	async findPullRequest(head: string, token: string): Promise<PullRequest | null> {
		let page = 1;
		while (true) {
			const res = await this.request(
				`/repos/${this.repo}/pulls?state=open&limit=${PAGE_SIZE}&page=${page}`,
				token,
				{ description: 'Failed to check for existing PR' },
			);
			const pulls = (await res.json()) as Array<
				PullRequest & { head?: { ref?: string; label?: string } }
			>;
			if (!Array.isArray(pulls) || pulls.length === 0) return null;

			const match = pulls.find((pr) => pr.head?.ref === head);
			if (match) return { number: match.number, html_url: match.html_url };
			if (pulls.length < PAGE_SIZE) return null;
			page++;
		}
	}

	// ---------- Branches ----------

	async findBranch(branches: string[], token: string): Promise<string | null> {
		for (const branch of branches) {
			const branchPath = branch.split('/').map(encodeURIComponent).join('/');
			const res = await this.requestTolerating(
				`/repos/${this.repo}/branches/${branchPath}`,
				token,
				[404],
				{ description: `Failed to check branch ${branch}` },
			);
			if (res) return branch;
		}
		return null;
	}

	async deleteBranch(branch: string, token: string): Promise<void> {
		const branchPath = branch.split('/').map(encodeURIComponent).join('/');
		await this.requestTolerating(`/repos/${this.repo}/branches/${branchPath}`, token, [404], {
			method: 'DELETE',
			description: 'Failed to delete branch',
		});
	}

	// ---------- URLs ----------

	remoteUrl(token: string): string {
		// Gitea accepts an access token as the basic-auth *username* with an
		// empty password; this form works regardless of which user owns it.
		const url = new URL(`${this.serverUrl}/${this.repo}.git`);
		url.username = token;
		return url.toString();
	}

	compareUrl(branch: string, baseBranch: string): string {
		return `${this.serverUrl}/${this.repo}/compare/${baseBranch}...${branch}`;
	}
}

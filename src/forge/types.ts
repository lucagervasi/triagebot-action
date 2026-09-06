/**
 * Forge-neutral data models.
 *
 * Every forge adapter normalizes its own API payloads into these shapes, so
 * the state machine, handlers, and prompts never see forge-specific fields.
 */

import * as v from 'valibot';

export const issueDetailsSchema = v.object({
	title: v.string(),
	body: v.string(),
	author: v.object({ login: v.string() }),
	labels: v.array(v.looseObject({ name: v.string() })),
	createdAt: v.string(),
	state: v.string(),
	number: v.number(),
	url: v.string(),
	comments: v.array(
		v.looseObject({
			author: v.object({ login: v.string() }),
			authorAssociation: v.string(),
			body: v.string(),
			createdAt: v.string(),
		}),
	),
});
export type IssueDetails = v.InferOutput<typeof issueDetailsSchema>;

export const repoLabelSchema = v.object({
	name: v.string(),
	description: v.nullable(v.string()),
});
export type RepoLabel = v.InferOutput<typeof repoLabelSchema>;

export interface PullRequest {
	number: number;
	html_url: string;
}

export interface CreatePullRequestOptions {
	head: string;
	base: string;
	title: string;
	body: string;
}

/**
 * How repo labels are split into the two groups the triage comment and the
 * labelling prompt consume. Defaults match the Astro monorepo conventions;
 * other projects override them via action inputs.
 */
export interface LabelPatterns {
	priority: RegExp;
	package: RegExp;
}

export const DEFAULT_LABEL_PATTERNS: LabelPatterns = {
	priority: /^- P\d/,
	package: /^pkg:/,
};

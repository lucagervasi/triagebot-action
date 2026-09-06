/**
 * Webhook payload parsing.
 *
 * GitHub and Gitea emit the same issue / issue_comment payload shape, so one
 * parser serves both. Keeping it isolated here is what a future GitLab adapter
 * would replace — GitLab's `object_kind` / `object_attributes` vocabulary does
 * not overlap with this one.
 */

export interface TriageEventPayload {
	action: string;
	isPullRequest: boolean;
	issueNumber: number;
	issueLabels: string[];
	commentAuthor?: string;
}

/**
 * Normalize a raw webhook payload. Returns null when the payload carries no
 * issue, which means there is nothing for the state machine to act on.
 */
export function parseWebhookEvent(payload: unknown): TriageEventPayload | null {
	if (!payload || typeof payload !== 'object') return null;
	const event = payload as Record<string, any>;
	const issue = event.issue;
	if (!issue) return null;

	return {
		action: String(event.action ?? ''),
		isPullRequest: Boolean(issue.pull_request),
		issueNumber: Number(issue.number),
		issueLabels: (issue.labels ?? []).map((l: { name: string }) => l.name),
		commentAuthor: event.comment?.user?.login,
	};
}

/**
 * Fix verification handler. Classifies whether a comment on an issue with
 * "fix pending" label is a positive confirmation that the fix works.
 *
 * If confirmed → creates PR, swaps to "fix verified".
 * If rejected → swaps to "fix rejected".
 */

import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import type { ActionContext } from '../context.ts';
import { createSession } from '../flue.ts';
import { generatePRContent } from '../pr.ts';

export async function handleVerifyFix(issueNumber: number, ctx: ActionContext): Promise<void> {
	const branch = await ctx.forge.findBranch(
		[`triagebot/fix-${issueNumber}`, `flue/fix-${issueNumber}`],
		ctx.readToken,
	);
	if (!branch) {
		throw new Error(`No fix branch found for issue #${issueNumber}`);
	}
	const issueDetails = await ctx.forge.fetchIssueDetails(issueNumber, ctx.readToken);

	// Find the latest non-bot comment.
	const latestUserComment = [...issueDetails.comments]
		.reverse()
		.find((c) => !ctx.botLogins.includes(c.author.login));

	if (!latestUserComment) {
		console.info('No user comment found, skipping verification.');
		return;
	}

	const agent = createAgent(() => ({
		sandbox: local({
			env: { GH_TOKEN: ctx.readToken },
		}),
		model: ctx.verificationModel,
	}));

	const session = await createSession(agent);

	// Classify the comment.
	const { data: classification } = await session.prompt(
		`You are reviewing a GitHub issue comment to determine if the commenter is confirming that a proposed fix works.

## Context

An automated triage bot found a fix for issue #${issueNumber} and published a preview release for the reporter to test. The bot asked the reporter to install the preview and confirm whether the fix resolves their issue.

## Issue
**${issueDetails.title}**

${issueDetails.body}

## Recent conversation
${issueDetails.comments
	.slice(-10)
	.map((c) => `**@${c.author.login}** (${c.authorAssociation}):\n${c.body}`)
	.join('\n\n---\n\n')}

## Comment to classify
**@${latestUserComment.author.login}** (${latestUserComment.authorAssociation}):
${latestUserComment.body}

## Your Task

Determine if this comment is a **positive confirmation** that the fix works. Examples of positive confirmation:
- "It works!"
- "Confirmed, this fixes my issue"
- "Tested the preview release, the bug is gone"
- "Thanks, that solved it"
- Thumbs up or similar positive reaction with clear reference to testing

Determine if this comment is a **negative confirmation** that the fix does NOT work. Examples:
- "Still broken"
- "Same error"
- "The fix doesn't work"
- "Tried the preview, issue persists"

Examples of comments that are NEITHER (inconclusive):
- Asking questions ("How do I install this?")
- Unrelated discussion
- Acknowledgment without testing ("Thanks, I'll try it later")

Return your classification.`,
		{
			result: v.object({
				status: v.pipe(
					v.picklist(['confirmed', 'rejected', 'inconclusive']),
					v.description(
						'confirmed = fix works, rejected = fix does not work, inconclusive = neither',
					),
				),
				reasoning: v.pipe(
					v.string(),
					v.description('Brief explanation of why you classified this way'),
				),
			}),
		},
	);

	console.info('Verification classification:', classification);

	if (classification.status === 'inconclusive') {
		console.info('Comment is inconclusive, taking no action.');
		return;
	}

	if (classification.status === 'rejected') {
		await ctx.forge.swapLabel(
			issueNumber,
			ctx.labels.fixPending,
			ctx.labels.fixRejected,
			ctx.writeToken,
		);
		return;
	}

	// Check if a PR already exists.
	const existingPr = await ctx.forge.findPullRequest(branch, ctx.readToken);

	if (existingPr) {
		console.info(`PR already exists: ${existingPr.html_url}`);
		await ctx.forge.swapLabel(
			issueNumber,
			ctx.labels.fixPending,
			ctx.labels.fixVerified,
			ctx.writeToken,
		);
		await ctx.forge.postComment(
			issueNumber,
			`The fix has been verified! A pull request already exists: ${existingPr.html_url}`,
			ctx.writeToken,
		);
		return;
	}

	// Generate PR content using the project skill or built-in fallback.
	const prOpts = {
		issueNumber,
		issueDetails,
		branch,
		baseBranch: ctx.baseBranch,
		confirmedBy: latestUserComment.author.login,
	};
	const prContent = await generatePRContent(session, prOpts, ctx);

	const pr = await ctx.forge.createPullRequest(
		{ head: branch, base: ctx.baseBranch, title: prContent.title, body: prContent.body },
		ctx.writeToken,
	);

	console.info(`PR created: ${pr.html_url}`);
	await ctx.forge.addLabels(pr.number, [ctx.labels.prFixVerified], ctx.writeToken);
	await ctx.forge.swapLabel(
		issueNumber,
		ctx.labels.fixPending,
		ctx.labels.fixVerified,
		ctx.writeToken,
	);

	await ctx.forge.postComment(
		issueNumber,
		`The fix has been verified! A pull request has been created: ${pr.html_url}`,
		ctx.writeToken,
	);
}

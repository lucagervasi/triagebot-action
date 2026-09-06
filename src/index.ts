/**
 * Entry point for the triagebot action.
 *
 * Reads the webhook payload and action inputs, resolves which forge it is
 * running against, then routes to the appropriate handler via the FSM router.
 */

import { readFileSync } from 'node:fs';
import type { ActionContext } from './context.ts';
import {
	createForge,
	defaultBotLogins,
	detectForgeKind,
	type ForgeKind,
	isForgeKind,
	type LabelPatterns,
	parseWebhookEvent,
	resolveApiUrl,
	resolveServerUrl,
} from './forge/index.ts';
import { handleCleanup } from './handlers/cleanup.ts';
import { handleRetriage } from './handlers/retriage.ts';
import { handleTriage } from './handlers/triage.ts';
import { handleVerifyFix } from './handlers/verify-fix.ts';
import { getInput } from './input.ts';
import { labelConfigFromInputs } from './labels.ts';
import { route, type TriageEvent } from './router.ts';

// ---------- Input helpers ----------

function parseBotLogins(input: string, kind: ForgeKind): string[] {
	const defaults = defaultBotLogins(kind);
	if (!input) return defaults;
	const extra = input
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return [...new Set([...defaults, ...extra])];
}

function getRequiredInput(name: string): string {
	const value = getInput(name);
	if (!value) {
		throw new Error(`Required input "${name}" is not set`);
	}
	return value;
}

function resolveForgeKind(): ForgeKind {
	const explicit = getInput('forge');
	if (!explicit) return detectForgeKind();
	if (!isForgeKind(explicit)) {
		throw new Error(`Unsupported "forge" input: "${explicit}". Expected "github" or "gitea".`);
	}
	return explicit;
}

function resolveLabelPatterns(): LabelPatterns | undefined {
	const priority = getInput('priority-label-pattern');
	const pkg = getInput('package-label-pattern');
	if (!priority && !pkg) return undefined;
	return {
		priority: priority ? new RegExp(priority) : /^- P\d/,
		package: pkg ? new RegExp(pkg) : /^pkg:/,
	};
}

// ---------- Main ----------

async function main(): Promise<void> {
	// Read the webhook payload. GitHub Actions and Gitea Actions both write it
	// to GITHUB_EVENT_PATH.
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new Error('GITHUB_EVENT_PATH is not set');
	}
	const payload = JSON.parse(readFileSync(eventPath, 'utf-8'));

	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		throw new Error('GITHUB_REPOSITORY is not set');
	}

	const kind = resolveForgeKind();
	const serverUrl = resolveServerUrl(getInput('server-url') || null);
	const apiUrl = resolveApiUrl(kind, serverUrl, getInput('api-url') || null);
	console.info(`Forge: ${kind} (server=${serverUrl}, api=${apiUrl})`);

	const forge = createForge({
		kind,
		repo,
		serverUrl,
		apiUrl,
		labelPatterns: resolveLabelPatterns(),
	});

	// Build the action context from inputs.
	const labels = labelConfigFromInputs(getInput);
	const ctx: ActionContext = {
		forge,
		repo,
		baseBranch: getInput('base-branch') || 'main',
		readToken: getRequiredInput('read-token'),
		writeToken: getRequiredInput('write-token'),
		anthropicApiKey: getInput('anthropic-api-key') || null,
		cloudflareApiKey: getInput('cloudflare-api-key') || null,
		cloudflareAccountId: getInput('cloudflare-account-id') || null,
		triageSkill: getRequiredInput('triage-skill'),
		prSkill: getInput('pr-skill') || null,
		prSkillName: getInput('pr-skill-name') || 'pr-writer',
		autoPrOnFix: getInput('auto-pr-on-fix') === 'true',
		buildCommand: getInput('build-command') || null,
		previewReleaseCommand: getInput('preview-release-command') || null,
		triageModel: getInput('triage-model') || 'anthropic/claude-opus-4-6',
		verificationModel: getInput('verification-model') || 'anthropic/claude-sonnet-4-6',
		labels,
		botLogins: parseBotLogins(getInput('bot-logins'), kind),
	};

	// Validate provider credentials before touching any globals so we don't
	// pollute process.env on an invalid configuration.
	const hasCloudflare = !!ctx.cloudflareApiKey && !!ctx.cloudflareAccountId;
	if (!ctx.anthropicApiKey && !hasCloudflare) {
		throw new Error(
			'No LLM credentials provided. Set "anthropic-api-key", or set both "cloudflare-api-key" and "cloudflare-account-id" to use Workers AI models.',
		);
	}
	if (ctx.cloudflareApiKey && !ctx.cloudflareAccountId) {
		throw new Error(
			'"cloudflare-api-key" is set but "cloudflare-account-id" is missing; both are required for Workers AI.',
		);
	}

	// Provide LLM credentials to Flue/pi-ai via env. The provider is selected by
	// the `triage-model` / `verification-model` prefix (e.g. "anthropic/..." or
	// "cloudflare-workers-ai/..."), and pi-ai reads the matching env var.
	if (ctx.anthropicApiKey) {
		process.env.ANTHROPIC_API_KEY = ctx.anthropicApiKey;
	}
	if (ctx.cloudflareApiKey) {
		process.env.CLOUDFLARE_API_KEY = ctx.cloudflareApiKey;
	}
	if (ctx.cloudflareAccountId) {
		process.env.CLOUDFLARE_ACCOUNT_ID = ctx.cloudflareAccountId;
	}

	// Parse the event into the shape the router expects.
	const parsed = parseWebhookEvent(payload);
	if (!parsed) {
		console.info('No issue in event payload, nothing to do.');
		return;
	}

	const event: TriageEvent = { ...parsed, botLogins: ctx.botLogins };

	const action = route(event, labels);
	console.info(`Router decision: ${action.type}`, action);

	switch (action.type) {
		case 'triage':
			await handleTriage(action.issueNumber, ctx);
			break;
		case 'retriage':
			await handleRetriage(action.issueNumber, action.currentLabel, ctx);
			break;
		case 'verify-fix':
			await handleVerifyFix(action.issueNumber, ctx);
			break;
		case 'cleanup':
			await handleCleanup(action.issueNumber, ctx);
			break;
		case 'skip':
			console.info(`Skipping: ${action.reason}`);
			break;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});

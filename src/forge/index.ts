/**
 * Forge selection. Resolves which code host the action is running against and
 * builds the matching client.
 */

import { BaseForge, type ForgeClient, type ForgeConfig, type ForgeKind } from './client.ts';
import { GiteaForge } from './gitea.ts';
import { GitHubForge } from './github.ts';
import { DEFAULT_LABEL_PATTERNS, type LabelPatterns } from './types.ts';

export { parseWebhookEvent } from './event.ts';
export * from './types.ts';
export type { ForgeClient, ForgeConfig, ForgeKind };
export { BaseForge, GiteaForge, GitHubForge };

export function isForgeKind(value: string): value is ForgeKind {
	return value === 'github' || value === 'gitea';
}

/**
 * Detect the host from the runner's environment. Gitea's act_runner sets
 * `GITEA_ACTIONS=true` alongside the GitHub-compatible variables, which is the
 * only reliable way to tell the two apart — `GITHUB_SERVER_URL` alone cannot
 * distinguish Gitea from GitHub Enterprise Server.
 */
export function detectForgeKind(env: NodeJS.ProcessEnv = process.env): ForgeKind {
	return env.GITEA_ACTIONS === 'true' ? 'gitea' : 'github';
}

export function resolveServerUrl(
	explicit: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const url = explicit || env.GITHUB_SERVER_URL || 'https://github.com';
	return url.replace(/\/+$/, '');
}

export function resolveApiUrl(
	kind: ForgeKind,
	serverUrl: string,
	explicit: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (explicit) return explicit.replace(/\/+$/, '');
	// Both GitHub Actions and Gitea Actions populate GITHUB_API_URL with the
	// correct base for their own host.
	if (env.GITHUB_API_URL) return env.GITHUB_API_URL.replace(/\/+$/, '');
	if (kind === 'gitea') return `${serverUrl}/api/v1`;
	return serverUrl === 'https://github.com' ? 'https://api.github.com' : `${serverUrl}/api/v3`;
}

/**
 * Bot accounts whose comments must never re-trigger the state machine.
 * Each host names its Actions bot differently.
 */
export function defaultBotLogins(kind: ForgeKind): string[] {
	return kind === 'gitea' ? ['gitea-actions[bot]', 'gitea-actions'] : ['github-actions[bot]'];
}

export function createForge(config: {
	kind: ForgeKind;
	repo: string;
	serverUrl: string;
	apiUrl: string;
	labelPatterns?: LabelPatterns;
}): ForgeClient {
	const forgeConfig = {
		repo: config.repo,
		serverUrl: config.serverUrl,
		apiUrl: config.apiUrl,
		labelPatterns: config.labelPatterns ?? DEFAULT_LABEL_PATTERNS,
	} satisfies Omit<ForgeConfig, 'kind'>;

	return config.kind === 'gitea' ? new GiteaForge(forgeConfig) : new GitHubForge(forgeConfig);
}

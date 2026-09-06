/**
 * Shared context passed to all handlers. Holds config, tokens, and the forge
 * client that abstracts the code host.
 */

import type { ForgeClient } from './forge/index.ts';
import type { LabelConfig } from './labels.ts';

export interface ActionContext {
	/** Code host adapter. Owns every API call and every forge-specific URL. */
	forge: ForgeClient;
	repo: string;
	/** Branch fixes are diffed and pull requests are opened against. */
	baseBranch: string;
	readToken: string;
	writeToken: string;
	anthropicApiKey: string | null;
	cloudflareApiKey: string | null;
	cloudflareAccountId: string | null;
	triageSkill: string;
	prSkill: string | null;
	prSkillName: string;
	autoPrOnFix: boolean;
	buildCommand: string | null;
	/**
	 * Shell command that publishes a testable preview build and prints one
	 * install URL per line. Null disables the preview/confirmation flow.
	 */
	previewReleaseCommand: string | null;
	triageModel: string;
	verificationModel: string;
	labels: LabelConfig;
	botLogins: string[];
}

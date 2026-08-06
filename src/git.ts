/**
 * Git operations that must run outside the agent's sandbox, so the write token
 * is never exposed to the LLM.
 */

import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ForgeClient } from './forge/index.ts';

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Stage all changes and create a commit. Passes the commit message as an argv
 * argument (never a shell string), so backticks, parentheses, quotes, and
 * newlines in an LLM-authored message can't be interpreted by the shell or
 * break the command.
 */
export async function gitCommit(message: string): Promise<GitResult> {
	try {
		await execFileAsync('git', ['add', '-A']);
		const { stdout, stderr } = await execFileAsync('git', ['commit', '-m', message]);
		return { exitCode: 0, stdout, stderr };
	} catch (err: any) {
		return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

/**
 * Push a branch to the forge over an authenticated https remote.
 * The remote URL contains the token, so it is never logged.
 */
export async function gitPush(
	forge: ForgeClient,
	branch: string,
	token: string,
	options?: { force?: boolean },
): Promise<GitResult> {
	const forceFlag = options?.force ? ' -f' : '';
	const remoteUrl = forge.remoteUrl(token);
	try {
		const { stdout, stderr } = await execAsync(`git push${forceFlag} ${remoteUrl} ${branch}`);
		return { exitCode: 0, stdout, stderr };
	} catch (err: any) {
		return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

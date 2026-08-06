import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ActionContext } from '../../src/context.ts';
import { createForge } from '../../src/forge/index.ts';
import { handleTriage } from '../../src/handlers/triage.ts';
import { labelConfigFromInputs } from '../../src/labels.ts';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalPath = process.env.PATH;
let tempDir: string | null = null;

afterEach(() => {
	process.chdir(originalCwd);
	globalThis.fetch = originalFetch;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function setupRepo(): string {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-e2e-'));
	mkdirSync(join(tempDir, '.agents', 'skills', 'triage'), { recursive: true });
	const skillDir = join(tempDir, '.agents', 'skills', 'triage');
	writeFileSync(
		join(skillDir, 'SKILL.md'),
		'---\nname: triage\ndescription: Triage a bug report.\n---\n\n# Triage\n',
	);
	writeFileSync(join(skillDir, 'reproduce.md'), '# Reproduce\n');
	writeFileSync(join(skillDir, 'diagnose.md'), '# Diagnose\n');
	writeFileSync(join(skillDir, 'verify.md'), '# Verify\n');
	writeFileSync(join(skillDir, 'fix.md'), '# Fix\n');
	mkdirSync(join(tempDir, 'packages', 'astro', 'src'), { recursive: true });
	writeFileSync(join(tempDir, 'packages', 'astro', 'src', 'index.ts'), 'export const value = 1;\n');
	writeFileSync(join(tempDir, 'README.md'), '# fixture\n');
	run('git', ['init', '-b', 'main'], tempDir);
	run('git', ['config', 'user.email', 'test@example.com'], tempDir);
	run('git', ['config', 'user.name', 'Test'], tempDir);
	run('git', ['add', '.'], tempDir);
	run('git', ['commit', '-m', 'initial'], tempDir);
	process.chdir(tempDir);
	return skillDir;
}

function configureLocalPushRemote(): void {
	assert.ok(tempDir);
	const remoteDir = join(tempDir, '.git', 'remote.git');
	run('git', ['init', '--bare', remoteDir], tempDir);
	run(
		'git',
		[
			'config',
			`url.file://${remoteDir}.insteadOf`,
			'https://x-access-token:write-token@github.com/withastro/astro.git',
		],
		tempDir,
	);
}

function installFakePnpm(url: string): void {
	assert.ok(tempDir);
	const binDir = join(tempDir, '.git', 'bin');
	mkdirSync(binDir, { recursive: true });
	const pnpmPath = join(binDir, 'pnpm');
	writeFileSync(
		pnpmPath,
		`#!/bin/sh\nprintf '%s' '{"packages":[{"url":"${url}"}]}' > preview-release.json\nexit 0\n`,
	);
	chmodSync(pnpmPath, 0o755);
	process.env.PATH = `${binDir}:${originalPath ?? ''}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function anthropicStream(toolInput: unknown): Response {
	const encoder = new TextEncoder();
	const body = [
		{
			type: 'message_start',
			message: {
				id: 'msg_test',
				type: 'message',
				role: 'assistant',
				content: [],
				model: 'claude-sonnet-4-6',
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_test', name: 'finish', input: {} },
		},
		{
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
		},
		{ type: 'content_block_stop', index: 0 },
		{
			type: 'message_delta',
			delta: { stop_reason: 'tool_use', stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: 'message_stop' },
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join('');

	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } },
	);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

describe('mocked triage flow', () => {
	it('runs an opened issue through unable-to-reproduce without real LLM or GitHub calls', async () => {
		const triageSkill = setupRepo();
		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabels: string[][] = [];
		let removedLabel: string | null = null;
		let anthropicCalls = 0;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				if (anthropicCalls > 5) {
					throw new Error('Too many mocked Anthropic calls');
				}
				if (anthropicCalls === 1) {
					return anthropicStream({
						reproducible: false,
						skipped: false,
						skippedReason: null,
					});
				}
				return anthropicStream({
					result:
						'- **Reproduced:** No\n- **Exploration:** No\n- **Unit Test:** No\n- **Priority:** Priority P3: Minor bug.\n',
				});
			}

			if (url.endsWith('/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://github.com/withastro/astro/issues/123',
				});
			}
			if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
			if (url.endsWith('/labels?per_page=100&page=1')) {
				return jsonResponse([
					{ name: '- P3: minor bug', description: 'Minor bug' },
					{ name: 'pkg: astro', description: 'Core package' },
				]);
			}
			if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
				comments.push(JSON.parse(String(init.body)).body);
				return jsonResponse({});
			}
			if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
				removedLabel = decodeURIComponent(url.split('/').at(-1) ?? '');
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
				addedLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const ctx: ActionContext = {
			forge: createForge({
				kind: 'github',
				repo: 'withastro/astro',
				serverUrl: 'https://github.com',
				apiUrl: 'https://api.github.com',
			}),
			repo: 'withastro/astro',
			baseBranch: 'main',
			previewReleaseCommand: null,
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['github-actions[bot]', 'astrobot-houston'],
		};

		await withTimeout(handleTriage(123, ctx), 10_000);

		assert.equal(anthropicCalls, 2);
		assert.equal(comments.length, 1);
		assert.match(comments[0], /Reproduced/);
		assert.equal(removedLabel, 'triage: needs triage');
		assert.deepEqual(addedLabels, [['triage: unable to reproduce']]);
	});

	it('publishes a preview release for fixed package changes before marking fix pending', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		installFakePnpm('https://pkg.pr.new/astro@test123');
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabels: string[][] = [];
		const removedLabels: string[] = [];
		let anthropicCalls = 0;
		let commentPromptIncludedPreviewUrl = false;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				const body = JSON.parse(String(init?.body ?? '{}'));
				if (anthropicCalls === 1) {
					return anthropicStream({ reproducible: true, skipped: false, skippedReason: null });
				}
				if (anthropicCalls === 2) return anthropicStream({ confidence: 'high' });
				if (anthropicCalls === 3) return anthropicStream({ verdict: 'bug', confidence: 'high' });
				if (anthropicCalls === 4) {
					return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
				}
				if (anthropicCalls === 5) {
					commentPromptIncludedPreviewUrl = JSON.stringify(body).includes(
						'https://pkg.pr.new/astro@test123',
					);
					return anthropicStream({
						result:
							'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n\n### Try this fix\n\nnpm i https://pkg.pr.new/astro@test123\n',
					});
				}
				if (anthropicCalls === 6) {
					return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
				}
				throw new Error('Too many mocked Anthropic calls');
			}

			if (url.endsWith('/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://github.com/withastro/astro/issues/123',
				});
			}
			if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
			if (url.endsWith('/labels?per_page=100&page=1')) {
				return jsonResponse([
					{ name: '- P3: minor bug', description: 'Minor bug' },
					{ name: 'pkg: astro', description: 'Core package' },
				]);
			}
			if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
				comments.push(JSON.parse(String(init.body)).body);
				return jsonResponse({});
			}
			if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
				removedLabels.push(decodeURIComponent(url.split('/').at(-1) ?? ''));
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
				addedLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const ctx: ActionContext = {
			forge: createForge({
				kind: 'github',
				repo: 'withastro/astro',
				serverUrl: 'https://github.com',
				apiUrl: 'https://api.github.com',
			}),
			repo: 'withastro/astro',
			baseBranch: 'main',
			previewReleaseCommand: null,
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['github-actions[bot]', 'astrobot-houston'],
		};

		await withTimeout(handleTriage(123, ctx), 20_000);

		assert.equal(anthropicCalls, 6);
		assert.equal(commentPromptIncludedPreviewUrl, true);
		assert.equal(comments.length, 1);
		assert.match(comments[0], /https:\/\/pkg\.pr\.new\/astro@test123/);
		assert.deepEqual(removedLabels, ['triage: needs triage']);
		assert.deepEqual(addedLabels, [['triage: fix pending'], ['- P3: minor bug', 'pkg: astro']]);
	});

	it('opens a pull request directly and marks fix verified when auto-pr-on-fix is enabled', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabels: string[][] = [];
		const prLabels: string[][] = [];
		const removedLabels: string[] = [];
		let anthropicCalls = 0;
		let createdPrHead: string | null = null;
		let createdPrBase: string | null = null;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				if (anthropicCalls === 1) {
					return anthropicStream({ reproducible: true, skipped: false, skippedReason: null });
				}
				if (anthropicCalls === 2) return anthropicStream({ confidence: 'high' });
				if (anthropicCalls === 3) return anthropicStream({ verdict: 'bug', confidence: 'high' });
				if (anthropicCalls === 4) {
					return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
				}
				if (anthropicCalls === 5) {
					return anthropicStream({ title: 'Fix the astro package', body: 'Closes #123' });
				}
				if (anthropicCalls === 6) {
					return anthropicStream({
						result:
							'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n',
					});
				}
				if (anthropicCalls === 7) {
					return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
				}
				throw new Error('Too many mocked Anthropic calls');
			}

			if (url.endsWith('/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://github.com/withastro/astro/issues/123',
				});
			}
			if (url.endsWith('/issues/123/comments?per_page=100')) return jsonResponse([]);
			if (url.includes('/pulls?head=withastro%3Atriagebot%2Ffix-123&state=open')) {
				return jsonResponse([]);
			}
			if (url.endsWith('/pulls') && init?.method === 'POST') {
				const payload = JSON.parse(String(init.body));
				createdPrHead = payload.head;
				createdPrBase = payload.base;
				return jsonResponse({
					number: 456,
					html_url: 'https://github.com/withastro/astro/pull/456',
				});
			}
			if (url.endsWith('/issues/456/labels') && init?.method === 'POST') {
				prLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			if (url.endsWith('/labels?per_page=100&page=1')) {
				return jsonResponse([
					{ name: '- P3: minor bug', description: 'Minor bug' },
					{ name: 'pkg: astro', description: 'Core package' },
				]);
			}
			if (url.endsWith('/issues/123/comments') && init?.method === 'POST') {
				comments.push(JSON.parse(String(init.body)).body);
				return jsonResponse({});
			}
			if (url.includes('/issues/123/labels/') && init?.method === 'DELETE') {
				removedLabels.push(decodeURIComponent(url.split('/').at(-1) ?? ''));
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/issues/123/labels') && init?.method === 'POST') {
				addedLabels.push(JSON.parse(String(init.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const ctx: ActionContext = {
			forge: createForge({
				kind: 'github',
				repo: 'withastro/astro',
				serverUrl: 'https://github.com',
				apiUrl: 'https://api.github.com',
			}),
			repo: 'withastro/astro',
			baseBranch: 'main',
			previewReleaseCommand: null,
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: true,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['github-actions[bot]', 'astrobot-houston'],
		};

		await withTimeout(handleTriage(123, ctx), 20_000);

		// PR content generated, then comment, then label selection: 7 LLM calls.
		assert.equal(anthropicCalls, 7);
		// A PR was opened directly from the fix branch against main.
		assert.equal(createdPrHead, 'triagebot/fix-123');
		assert.equal(createdPrBase, 'main');
		// The PR got the fix-verified PR label.
		assert.deepEqual(prLabels, [['fix verified']]);
		// The issue moved straight to fix verified (no preview => not fix pending).
		assert.deepEqual(removedLabels, ['triage: needs triage']);
		assert.deepEqual(addedLabels, [['triage: fix verified'], ['- P3: minor bug', 'pkg: astro']]);
		// The reporter comment links the opened PR.
		assert.equal(comments.length, 1);
		assert.match(comments[0], /pull\/456/);
	});

	it('drives the same flow against a Gitea instance, addressing labels by id', async () => {
		const triageSkill = setupRepo();
		process.env.ANTHROPIC_API_KEY = 'test-key';
		const comments: string[] = [];
		const addedLabelIds: number[][] = [];
		const deletedLabelPaths: string[] = [];
		let anthropicCalls = 0;

		// Note: no "triage: unable to reproduce" here. Gitea does not create
		// labels implicitly, so the adapter has to create it before applying it.
		const repoLabels = [
			{ id: 7, name: 'triage: needs triage', description: 'waiting' },
			{ id: 11, name: '- P3: minor bug', description: 'Minor bug' },
			{ id: 12, name: 'pkg: astro', description: 'Core package' },
		];
		let createdLabelName: string | null = null;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.startsWith('https://api.anthropic.com/')) {
				anthropicCalls += 1;
				if (anthropicCalls > 5) throw new Error('Too many mocked Anthropic calls');
				if (anthropicCalls === 1) {
					return anthropicStream({ reproducible: false, skipped: false, skippedReason: null });
				}
				return anthropicStream({
					result:
						'- **Reproduced:** No\n- **Exploration:** No\n- **Unit Test:** No\n- **Priority:** Priority P3: Minor bug.\n',
				});
			}

			// Everything below must sit under the instance's /api/v1 base.
			assert.ok(
				url.startsWith('https://gitea.example.com/api/v1/'),
				`call escaped the Gitea API base: ${url}`,
			);

			if (url.endsWith('/repos/acme/widgets/issues/123')) {
				return jsonResponse({
					title: 'Example issue',
					body: 'Issue body',
					user: { login: 'reporter' },
					labels: [{ name: 'triage: needs triage' }],
					created_at: '2026-01-01T00:00:00Z',
					state: 'open',
					number: 123,
					html_url: 'https://gitea.example.com/acme/widgets/issues/123',
				});
			}
			// Gitea paginates with limit/page, not per_page.
			if (url.includes('/issues/123/comments?limit=100&page=1')) return jsonResponse([]);
			if (url.includes('/repos/acme/widgets/labels?limit=100&page=1')) {
				return jsonResponse(repoLabels);
			}
			if (url.endsWith('/repos/acme/widgets/labels') && method === 'POST') {
				createdLabelName = JSON.parse(String(init?.body)).name;
				const created = { id: 42, name: createdLabelName, description: '' };
				repoLabels.push(created);
				return jsonResponse(created);
			}
			if (url.endsWith('/issues/123/comments') && method === 'POST') {
				comments.push(JSON.parse(String(init?.body)).body);
				return jsonResponse({});
			}
			if (url.includes('/issues/123/labels/') && method === 'DELETE') {
				deletedLabelPaths.push(url.split('/').at(-1) ?? '');
				return new Response(null, { status: 204 });
			}
			if (url.endsWith('/issues/123/labels') && method === 'POST') {
				addedLabelIds.push(JSON.parse(String(init?.body)).labels);
				return jsonResponse([]);
			}
			throw new Error(`Unexpected fetch: ${method} ${url}`);
		};

		const ctx: ActionContext = {
			forge: createForge({
				kind: 'gitea',
				repo: 'acme/widgets',
				serverUrl: 'https://gitea.example.com',
				apiUrl: 'https://gitea.example.com/api/v1',
			}),
			repo: 'acme/widgets',
			baseBranch: 'main',
			previewReleaseCommand: null,
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			triageSkill,
			prSkill: null,
			prSkillName: 'astro-pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['gitea-actions[bot]'],
		};

		await withTimeout(handleTriage(123, ctx), 10_000);

		assert.equal(anthropicCalls, 2);
		assert.equal(comments.length, 1);
		assert.match(comments[0], /Reproduced/);
		// The old label came off by numeric id, not by name.
		assert.deepEqual(deletedLabelPaths, ['7']);
		// The new state label did not exist, so it was created and then applied.
		assert.equal(createdLabelName, 'triage: unable to reproduce');
		assert.deepEqual(addedLabelIds, [[42]]);
	});
});

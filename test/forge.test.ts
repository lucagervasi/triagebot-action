import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
	createForge,
	defaultBotLogins,
	detectForgeKind,
	type ForgeClient,
	isForgeKind,
	resolveApiUrl,
	resolveServerUrl,
} from '../src/forge/index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface RecordedCall {
	method: string;
	url: string;
	body: unknown;
}

/**
 * Install a fetch stub driven by a routing table. Keys are matched as
 * substrings of `METHOD url`; the first match wins.
 */
function mockApi(routes: Array<[string, (call: RecordedCall) => Response]>): RecordedCall[] {
	const calls: RecordedCall[] = [];
	globalThis.fetch = (async (input: any, init: any) => {
		const method = (init?.method ?? 'GET').toUpperCase();
		const url = String(input);
		const call: RecordedCall = {
			method,
			url,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		for (const [pattern, handler] of routes) {
			if (`${method} ${url}`.includes(pattern)) return handler(call);
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`);
	}) as typeof fetch;
	return calls;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function gitea(): ForgeClient {
	return createForge({
		kind: 'gitea',
		repo: 'acme/widgets',
		serverUrl: 'https://gitea.example.com',
		apiUrl: 'https://gitea.example.com/api/v1',
	});
}

function github(): ForgeClient {
	return createForge({
		kind: 'github',
		repo: 'acme/widgets',
		serverUrl: 'https://github.com',
		apiUrl: 'https://api.github.com',
	});
}

const GITEA_LABELS = [
	{ id: 7, name: 'triage: needs triage', description: 'waiting' },
	{ id: 8, name: 'triage: fix pending', description: null },
];

describe('forge configuration', () => {
	it('detects Gitea only from GITEA_ACTIONS', () => {
		assert.equal(detectForgeKind({ GITEA_ACTIONS: 'true' } as NodeJS.ProcessEnv), 'gitea');
		assert.equal(detectForgeKind({ GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv), 'github');
		// A non-github.com server URL is GitHub Enterprise, not Gitea.
		assert.equal(
			detectForgeKind({ GITHUB_SERVER_URL: 'https://ghe.corp' } as NodeJS.ProcessEnv),
			'github',
		);
	});

	it('validates the forge input', () => {
		assert.ok(isForgeKind('gitea'));
		assert.ok(isForgeKind('github'));
		assert.ok(!isForgeKind('gitlab'));
	});

	it('derives API URLs per host', () => {
		const env = {} as NodeJS.ProcessEnv;
		assert.equal(
			resolveApiUrl('github', 'https://github.com', null, env),
			'https://api.github.com',
		);
		assert.equal(resolveApiUrl('github', 'https://ghe.corp', null, env), 'https://ghe.corp/api/v3');
		assert.equal(
			resolveApiUrl('gitea', 'https://gitea.example.com', null, env),
			'https://gitea.example.com/api/v1',
		);
		// An explicit input always wins, and trailing slashes are normalized.
		assert.equal(
			resolveApiUrl('gitea', 'https://gitea.example.com', 'https://other/api/v1/', env),
			'https://other/api/v1',
		);
		// Both runners publish GITHUB_API_URL for their own host.
		assert.equal(
			resolveApiUrl('gitea', 'https://gitea.example.com', null, {
				GITHUB_API_URL: 'https://gitea.example.com/api/v1',
			} as NodeJS.ProcessEnv),
			'https://gitea.example.com/api/v1',
		);
	});

	it('resolves the server URL from input, then env, then github.com', () => {
		assert.equal(
			resolveServerUrl('https://gitea.example.com/', {} as NodeJS.ProcessEnv),
			'https://gitea.example.com',
		);
		assert.equal(
			resolveServerUrl(null, { GITHUB_SERVER_URL: 'https://ghe.corp' } as NodeJS.ProcessEnv),
			'https://ghe.corp',
		);
		assert.equal(resolveServerUrl(null, {} as NodeJS.ProcessEnv), 'https://github.com');
	});

	it('ignores each host own Actions bot by default', () => {
		assert.deepEqual(defaultBotLogins('github'), ['github-actions[bot]']);
		assert.deepEqual(defaultBotLogins('gitea'), ['gitea-actions[bot]', 'gitea-actions']);
	});
});

describe('GiteaForge labels', () => {
	it('adds labels by numeric id, not by name', async () => {
		const calls = mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/labels', () => json(GITEA_LABELS)],
			['POST https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/labels', () => json({})],
		]);

		await gitea().addLabels(5, ['triage: fix pending'], 'tok');

		const post = calls.find((c) => c.method === 'POST');
		assert.deepEqual(post?.body, { labels: [8] });
	});

	it('creates a label that does not exist yet, since Gitea will not', async () => {
		const calls = mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/labels', () => json(GITEA_LABELS)],
			[
				'POST https://gitea.example.com/api/v1/repos/acme/widgets/labels',
				() => json({ id: 99, name: 'triage: failed', description: '' }),
			],
			['POST https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/labels', () => json({})],
		]);

		await gitea().addLabels(5, ['triage: failed'], 'tok');

		const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/labels'));
		assert.equal((created?.body as any)?.name, 'triage: failed');
		const applied = calls.find((c) => c.url.includes('/issues/5/labels'));
		assert.deepEqual(applied?.body, { labels: [99] });
	});

	it('removes a label by resolving its id', async () => {
		const calls = mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/labels', () => json(GITEA_LABELS)],
			['DELETE', () => new Response(null, { status: 204 })],
		]);

		await gitea().removeLabel(5, 'triage: needs triage', 'tok');

		const del = calls.find((c) => c.method === 'DELETE');
		assert.equal(del?.url, 'https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/labels/7');
	});

	it('does not call DELETE for a label the repo does not have', async () => {
		const calls = mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/labels', () => json(GITEA_LABELS)],
		]);

		await gitea().removeLabel(5, 'triage: never created', 'tok');

		assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
	});

	it('swaps labels in one remove-then-add sequence and caches the label list', async () => {
		const calls = mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/labels', () => json(GITEA_LABELS)],
			['DELETE', () => new Response(null, { status: 204 })],
			['POST https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/labels', () => json({})],
		]);

		await gitea().swapLabel(5, 'triage: needs triage', 'triage: fix pending', 'tok');

		assert.equal(
			calls.filter((c) => c.method === 'GET').length,
			1,
			'the repo label list should be fetched once per run',
		);
		assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
		assert.deepEqual(calls.find((c) => c.method === 'POST')?.body, { labels: [8] });
	});

	it('splits priority and package labels with the configured patterns', async () => {
		mockApi([
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/labels',
				() =>
					json([
						{ id: 1, name: 'prio/high', description: 'urgent' },
						{ id: 2, name: 'area/core', description: null },
						{ id: 3, name: 'unrelated', description: null },
					]),
			],
		]);

		const forge = createForge({
			kind: 'gitea',
			repo: 'acme/widgets',
			serverUrl: 'https://gitea.example.com',
			apiUrl: 'https://gitea.example.com/api/v1',
			labelPatterns: { priority: /^prio\//, package: /^area\// },
		});

		const { priorityLabels, packageLabels } = await forge.fetchRepoLabels('tok');
		assert.deepEqual(
			priorityLabels.map((l) => l.name),
			['prio/high'],
		);
		assert.deepEqual(
			packageLabels.map((l) => l.name),
			['area/core'],
		);
		// Gitea returns undefined rather than null for an unset description.
		assert.equal(packageLabels[0].description, null);
	});
});

describe('GiteaForge pull requests and branches', () => {
	it('finds a PR by filtering head.ref client-side', async () => {
		const calls = mockApi([
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/pulls',
				() =>
					json([
						{
							number: 1,
							html_url: 'https://gitea.example.com/acme/widgets/pulls/1',
							head: { ref: 'other' },
						},
						{
							number: 42,
							html_url: 'https://gitea.example.com/acme/widgets/pulls/42',
							head: { ref: 'triagebot/fix-5' },
						},
					]),
			],
		]);

		const pr = await gitea().findPullRequest('triagebot/fix-5', 'tok');

		assert.deepEqual(pr, {
			number: 42,
			html_url: 'https://gitea.example.com/acme/widgets/pulls/42',
		});
		// No `head=` query param, because Gitea does not support one.
		assert.ok(!calls[0].url.includes('head='));
	});

	it('returns null when no open PR matches the branch', async () => {
		mockApi([['GET https://gitea.example.com/api/v1/repos/acme/widgets/pulls', () => json([])]]);
		assert.equal(await gitea().findPullRequest('triagebot/fix-5', 'tok'), null);
	});

	it('checks branch existence via /branches, not git/matching-refs', async () => {
		const calls = mockApi([
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/branches/triagebot/fix-5',
				() => json({ name: 'triagebot/fix-5' }, 404),
			],
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/branches/flue/fix-5',
				() => json({ name: 'flue/fix-5' }),
			],
		]);

		const found = await gitea().findBranch(['triagebot/fix-5', 'flue/fix-5'], 'tok');

		assert.equal(found, 'flue/fix-5');
		assert.ok(calls.every((c) => !c.url.includes('matching-refs')));
	});

	it('treats a missing branch as a successful cleanup', async () => {
		mockApi([['DELETE', () => new Response('', { status: 404 })]]);
		await gitea().deleteBranch('triagebot/fix-5', 'tok');
	});
});

describe('GiteaForge issue normalization', () => {
	it('defaults the missing author_association instead of failing to parse', async () => {
		mockApi([
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/issues/5?',
				() =>
					json({
						title: 't',
						body: 'b',
						user: { login: 'reporter' },
						labels: [],
						created_at: '2026-01-01T00:00:00Z',
						state: 'open',
						number: 5,
						html_url: 'https://gitea.example.com/acme/widgets/issues/5',
					}),
			],
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/comments',
				() =>
					json([{ user: { login: 'someone' }, body: 'hi', created_at: '2026-01-02T00:00:00Z' }]),
			],
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/issues/5',
				() =>
					json({
						title: 't',
						body: 'b',
						user: { login: 'reporter' },
						labels: [],
						created_at: '2026-01-01T00:00:00Z',
						state: 'open',
						number: 5,
						html_url: 'https://gitea.example.com/acme/widgets/issues/5',
					}),
			],
		]);

		const issue = await gitea().fetchIssueDetails(5, 'tok');

		assert.equal(issue.number, 5);
		assert.equal(issue.comments.length, 1);
		assert.equal(issue.comments[0].authorAssociation, 'NONE');
		assert.equal(issue.comments[0].author.login, 'someone');
	});

	it('tolerates a null issue body', async () => {
		mockApi([
			['GET https://gitea.example.com/api/v1/repos/acme/widgets/issues/5/comments', () => json([])],
			[
				'GET https://gitea.example.com/api/v1/repos/acme/widgets/issues/5',
				() =>
					json({
						title: 't',
						body: null,
						user: { login: 'reporter' },
						labels: [],
						created_at: '2026-01-01T00:00:00Z',
						state: 'open',
						number: 5,
						html_url: 'https://x',
					}),
			],
		]);

		const issue = await gitea().fetchIssueDetails(5, 'tok');
		assert.equal(issue.body, '');
	});
});

describe('forge URLs', () => {
	it('builds a Gitea push remote with the token as username', () => {
		assert.equal(gitea().remoteUrl('abc123'), 'https://abc123@gitea.example.com/acme/widgets.git');
	});

	it('keeps the GitHub push remote unchanged', () => {
		assert.equal(
			github().remoteUrl('write-token'),
			'https://x-access-token:write-token@github.com/acme/widgets.git',
		);
	});

	it('uses each forge own compare URL shape', () => {
		assert.equal(
			github().compareUrl('triagebot/fix-5', 'main'),
			'https://github.com/acme/widgets/compare/triagebot/fix-5?expand=1',
		);
		assert.equal(
			gitea().compareUrl('triagebot/fix-5', 'develop'),
			'https://gitea.example.com/acme/widgets/compare/develop...triagebot/fix-5',
		);
	});

	it('points run URLs at the configured server', () => {
		assert.equal(gitea().runUrl('99'), 'https://gitea.example.com/acme/widgets/actions/runs/99');
	});
});

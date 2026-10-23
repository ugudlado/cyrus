import type { ILogger, RepositoryConfig } from "cyrus-core";
import { TenantRegistry } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { LiveChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { PromptBuilder } from "../src/PromptBuilder.js";
import { SlackChatAdapter } from "../src/SlackChatAdapter.js";
import { ZulipChatAdapter } from "../src/ZulipChatAdapter.js";
import { expectedRoutingBlock } from "./helpers/routingBlock.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

// Fixture data only (no real repository or customer names).
const repo = (
	id: string,
	name: string,
	ws: string,
	extra: Partial<RepositoryConfig> = {},
): RepositoryConfig =>
	({
		id,
		name,
		repositoryPath: `/repos/${id}`,
		workspaceBaseDir: "/ws",
		baseBranch: "main",
		linearWorkspaceId: ws,
		githubUrl: `https://github.com/${ws}-org/${name}`,
		isActive: true,
		...extra,
	}) as RepositoryConfig;

const tenant = (id: string, repositoryIds: string[]) => ({
	id,
	linearWorkspaceId: `ws-${id}`,
	linear: {
		clientIdEnv: "A",
		clientSecretEnv: "B",
		webhookSecretEnv: "C",
	},
	repositoryIds,
});

const alphaApp = repo("a1", "alpha-app", "ws-alpha");
const alphaTwo = repo("a2", "alpha-two", "ws-alpha");
const betaOne = repo("b1", "beta-one", "ws-beta");
const betaTwo = repo("b2", "beta-two", "ws-beta");
const soloRepo = repo("s1", "solo-only", "ws-solo");
// In the alpha workspace but NOT in the alpha tenant's repositoryIds.
const stray = repo("x1", "stray-repo", "ws-alpha");

function makeBuilder(
	repos: RepositoryConfig[],
	registry?: TenantRegistry,
): PromptBuilder {
	return new PromptBuilder({
		logger: silentLogger,
		repositories: new Map(repos.map((r) => [r.id, r])),
		issueTrackers: new Map(),
		gitService: {} as never,
		tenantRegistry: registry,
	});
}

const registry = () =>
	new TenantRegistry([
		tenant("alpha", ["a1", "a2"]),
		tenant("beta", ["b1", "b2"]),
		tenant("solo", ["s1"]),
	]);

const block = (repos: RepositoryConfig[], current: RepositoryConfig) =>
	expectedRoutingBlock(
		repos.map((r) => ({
			name: r.name,
			githubUrl: r.githubUrl as string,
			current: r.id === current.id,
		})),
	);

describe("PromptBuilder routing context is tenant-scoped", () => {
	const all = [alphaApp, alphaTwo, betaOne, betaTwo, soloRepo, stray];

	it("builds each tenant's block from that tenant's repositoryIds only", () => {
		const builder = makeBuilder(all, registry());
		expect(builder.generateRoutingContextForTenant("alpha")).toBe(
			block([alphaApp, alphaTwo], alphaApp),
		);
		expect(builder.generateRoutingContextForTenant("beta")).toBe(
			block([betaOne, betaTwo], betaOne),
		);
	});

	it("never pulls in a same-workspace repository the tenant does not own", () => {
		const out = makeBuilder(all, registry()).generateRoutingContextForTenant(
			"alpha",
		);
		expect(out).not.toContain("stray-repo");
		expect(out).not.toContain("beta-one");
	});

	it("returns an empty string for an unknown tenant and for a single-repo tenant", () => {
		const builder = makeBuilder(all, registry());
		expect(builder.generateRoutingContextForTenant("ghost")).toBe("");
		expect(builder.generateRoutingContextForTenant("solo")).toBe("");
		expect(makeBuilder(all).generateRoutingContextForTenant("alpha")).toBe("");
	});

	it("skips inactive repositories", () => {
		const inactive = { ...alphaTwo, isActive: false } as RepositoryConfig;
		const builder = makeBuilder([alphaApp, inactive], registry());
		expect(builder.generateRoutingContextForTenant("alpha")).toBe("");
	});

	it("orchestrator routing (generateRoutingContext) inherits the tenant list", () => {
		const builder = makeBuilder(all, registry());
		expect(builder.generateRoutingContext(alphaTwo)).toBe(
			block([alphaApp, alphaTwo], alphaTwo),
		);
	});

	it("the all-workspaces block, with tenants, is exactly each tenant's own block", () => {
		const builder = makeBuilder(
			[alphaApp, alphaTwo, betaOne, betaTwo],
			registry(),
		);
		expect(builder.generateRoutingContextForAllWorkspaces()).toBe(
			`${block([alphaApp, alphaTwo], alphaApp)}\n\n${block([betaOne, betaTwo], betaOne)}`,
		);
	});

	it("without tenants nothing changes: workspace expansion, byte-identical", () => {
		const builder = makeBuilder([alphaApp, alphaTwo, betaOne, betaTwo, stray]);
		expect(builder.generateRoutingContextForAllWorkspaces()).toBe(
			`${block([alphaApp, alphaTwo, stray], alphaApp)}\n\n${block([betaOne, betaTwo], betaOne)}`,
		);
	});
});

describe("SlackChatAdapter resolves the routing context per event tenant", () => {
	const repos = [alphaApp, alphaTwo, betaOne, betaTwo];
	const reg = registry();
	const builder = makeBuilder(repos, reg);
	const provider = new LiveChatRepositoryProvider(
		new Map(repos.map((r) => [r.id, r])),
		() => ({}),
		reg,
	);
	const adapter = new SlackChatAdapter(provider, silentLogger, {
		repositoryRoutingContext: (tenantId) =>
			tenantId === undefined
				? ""
				: builder.generateRoutingContextForTenant(tenantId),
	});
	const event = (tenantId?: string) =>
		({
			tenantId,
			payload: {
				user: "U1",
				channel: "C1",
				text: "hi",
				ts: "1.0",
				event_ts: "1.0",
				type: "app_mention",
			},
		}) as never;
	const routingSection = (prompt: string) => {
		const start = prompt.indexOf("<repository_routing_context>");
		const endTag = "</repository_routing_context>";
		const end = prompt.indexOf(endTag);
		return start < 0 ? "" : prompt.slice(start, end + endTag.length);
	};

	it("shows tenant alpha only alpha's repositories and paths", () => {
		const prompt = adapter.buildSystemPrompt(event("alpha"));
		expect(routingSection(prompt)).toBe(block([alphaApp, alphaTwo], alphaApp));
		expect(prompt).toContain("- /repos/a1\n- /repos/a2\n");
		for (const other of ["beta-one", "beta-two", "/repos/b1", "/repos/b2"]) {
			expect(prompt).not.toContain(other);
		}
	});

	it("renders tenant alpha's ENTIRE system prompt exactly", () => {
		const routing = block([alphaApp, alphaTwo], alphaApp);
		expect(
			adapter.buildSystemPrompt(event("alpha")),
		).toBe(`You are participating in a Slack thread.

## Context
- **Requested by**: U1
- **Channel**: C1

## When to Respond (IMPORTANT)
- After you are first @mentioned, you receive **every** subsequent message in this thread, not just the ones aimed at you. Do not treat every message as a request for you.
- Respond ONLY when at least one of these is true:
  1. The message asks a question you can genuinely and helpfully answer, OR
  2. Someone addresses you directly — by name ("Cyrus, …") or with an @mention.
- For anything else — side conversation between people, acknowledgements ("thanks", "👍"), status chatter, or messages clearly not directed at you — do NOT reply.
- When you should stay silent, output exactly \`<<NO_RESPONSE>>\` and nothing else — no reasoning, no explanation, not a single word before or after the token.
- NEVER narrate your decision about whether to respond. Your entire output is posted verbatim to the thread — there is no private scratchpad. Thoughts like "the user didn't address me by name, so I should stay quiet" or "they addressed me by name, so I'm listening again" must never appear in your output. Either emit the bare token, or reply directly to the user's message as if the decision never happened.
- When you do respond, be genuinely helpful and concise.

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Slack
- If the user's request involves code changes, help them plan the work and suggest creating an issue in their project tracker (Linear, Jira, or GitHub Issues)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory

## Repository Access
- You have read-only access to the following configured repositories:
- /repos/a1
- /repos/a2

- If you need to inspect source code in one of these repositories, use:
  - Bash(git -C * pull)

- You are explicitly allowed to run git pull with:
  - Bash(git -C * pull)
			


${routing}

## Self-Knowledge
- If the user asks about your capabilities, features, how you work, what you can do, setup instructions, or anything related to Cyrus documentation, use the \`mcp__cyrus-docs__search_documentation\` tool to look up the answer from the official Cyrus docs.
- Always prefer searching the docs over guessing or relying on your training data for Cyrus-specific questions.

## Orchestration Notes
- If the user asks you to make repo code changes immediately, use these steps:
  - First run \`mcp__linear__get_user\` with \`query: "me"\` to get your Linear identity.
  - Create an Issue in the user's tracker for the requested work (for example using \`mcp__linear__save_issue\`), including enough context and acceptance criteria to execute it. Default the issue status/state to "Backlog". **IMPORTANT: Never set the status to "Triage".**
  - To route the issue to a specific repository, add \`[repo=repo-name]\` to the issue description. To target a specific branch, use \`[repo=repo-name#branch-name]\`. For multiple repos: \`repos=repo1,repo2\`.
  - To choose a specific execution harness, add \`[agent=claude]\`, \`[agent=gemini]\`, \`[agent=codex]\`, \`[agent=cursor]\`, or \`[agent=opencode]\` to the issue description.
  - To choose both execution harness and model from Linear labels, apply a \`<provider>/<model>\` label such as \`openai/gpt-5.5\`. For OpenCode, use \`opencode/<provider>/<model>\`, such as \`opencode/openai/gpt-5.5\`.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.
  - To send mid-flight feedback or corrections to a running child session, use \`mcp__cyrus-tools__linear_agent_give_feedback\` with the session ID returned by \`linear_get_agent_sessions\`. This is the ONLY way to directly prompt a running child agent. \`mcp__linear__save_comment\` does NOT trigger or notify the agent in any way — it just writes a comment on the issue, which the running session will not see. Always prefer \`linear_agent_give_feedback\` when the child agent is actively working.

## Slack Message Formatting (CRITICAL)
Your response will be posted as a Slack message. Slack uses its own "mrkdwn" format, which is NOT standard Markdown. You MUST follow these rules exactly.

NEVER use any of the following — they do not render in Slack and will appear as broken plain text:
- NO tables (no | --- | syntax — use numbered lists or plain text instead)
- NO headers (no # syntax — use *bold text* on its own line instead)
- NO [text](url) links — use <url|text> instead
- NO **double asterisk** bold — use *single asterisk* instead
- NO image embeds

Supported mrkdwn syntax:
- Bold: *bold text* (single asterisks only)
- Italic: _italic text_
- Strikethrough: ~struck text~
- Inline code: \`code\`
- Code blocks: \`\`\`code block\`\`\`
- Blockquote: > quoted text (at start of line)
- Links: <https://example.com|display text>
- Lists: use plain numbered lines (1. item) or dashes (- item) with newlines`);
	});

	it("shows tenant beta only beta's repositories and paths", () => {
		const prompt = adapter.buildSystemPrompt(event("beta"));
		expect(routingSection(prompt)).toBe(block([betaOne, betaTwo], betaOne));
		for (const other of ["alpha-app", "alpha-two", "/repos/a1", "/repos/a2"]) {
			expect(prompt).not.toContain(other);
		}
	});

	it("shows an untagged event or unknown tenant no repositories at all", () => {
		for (const id of [undefined, "ghost"]) {
			const prompt = adapter.buildSystemPrompt(event(id));
			expect(routingSection(prompt)).toBe("");
			expect(prompt).toContain(
				"- No repository paths are configured for this chat session.",
			);
			for (const name of ["alpha-app", "beta-one", "/repos/"]) {
				expect(prompt).not.toContain(name);
			}
		}
	});

	it("still accepts a fixed string (no tenants: today's output)", () => {
		const fixed = block([alphaApp, alphaTwo], alphaApp);
		const plain = new SlackChatAdapter(
			new LiveChatRepositoryProvider(
				new Map(repos.map((r) => [r.id, r])),
				() => ({}),
			),
			silentLogger,
			{ repositoryRoutingContext: `\n${fixed}\n` },
		);
		expect(routingSection(plain.buildSystemPrompt(event()))).toBe(fixed);
	});
});

describe("ZulipChatAdapter routing context option", () => {
	const repos = [alphaApp, alphaTwo];
	const provider = new LiveChatRepositoryProvider(
		new Map(repos.map((r) => [r.id, r])),
		() => ({}),
	);
	const zulipEvent = {
		trigger: "direct_message",
		message: {
			id: 1,
			type: "private",
			content: "hi",
			sender_id: 7,
			sender_email: "x@example.test",
			sender_full_name: "X",
			display_recipient: [],
			timestamp: 1,
		},
		data: "hi",
		botEmail: "bot@example.test",
		botFullName: "Bot",
		credentials: {},
	} as never;

	it("accepts a resolver and a plain string alike", () => {
		const fixed = block([alphaApp, alphaTwo], alphaApp);
		const fromString = new ZulipChatAdapter(provider, silentLogger, {
			repositoryRoutingContext: fixed,
		}).buildSystemPrompt(zulipEvent);
		const fromResolver = new ZulipChatAdapter(provider, silentLogger, {
			repositoryRoutingContext: () => fixed,
		}).buildSystemPrompt(zulipEvent);
		expect(fromResolver).toBe(fromString);
		expect(fromString).toContain(fixed);
	});
});

describe("LiveChatRepositoryProvider fails closed with tenants", () => {
	const repos = new Map([alphaApp, alphaTwo, betaOne].map((r) => [r.id, r]));
	const ws = { "ws-alpha": {}, "ws-beta": {} };

	it("enabled + no tenant id: no paths, no default repo, no default workspace", () => {
		const p = new LiveChatRepositoryProvider(repos, () => ws, registry());
		expect(p.getRepositoryPaths()).toEqual([]);
		expect(p.getDefaultRepository()).toBeUndefined();
		expect(p.getDefaultLinearWorkspaceId()).toBeUndefined();
	});

	it("disabled + no tenant id: today's unscoped output", () => {
		for (const reg of [undefined, new TenantRegistry([])]) {
			const p = new LiveChatRepositoryProvider(repos, () => ws, reg);
			expect(p.getRepositoryPaths()).toEqual([
				"/repos/a1",
				"/repos/a2",
				"/repos/b1",
			]);
			expect(p.getDefaultRepository()?.id).toBe("a1");
			expect(p.getDefaultLinearWorkspaceId()).toBe("ws-alpha");
		}
	});
});

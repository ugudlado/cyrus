import type {
	EdgeWorkerConfig,
	ILogger,
	KittuAgentSession,
	RepositoryConfig,
	RunnerType,
} from "kittu-core";
import { validateAllowedRunners } from "kittu-core";
import { describe, expect, it, vi } from "vitest";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

const logger = () =>
	({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}) as unknown as ILogger & { info: ReturnType<typeof vi.fn> };

const svc = (over: Partial<EdgeWorkerConfig> = {}, log?: ILogger) =>
	new RunnerSelectionService(
		{ repositories: [], ...over } as EdgeWorkerConfig,
		log,
	);

describe("allowedRunners: selection paths fall back to the first allowed runner", () => {
	const only = { allowedRunners: ["claude"] as RunnerType[] };

	it.each([
		["description [agent=codex]", [], "Please [agent=codex] do it"],
		["description [agent=opencode]", [], "[agent=opencode]"],
		["description [agent=cursor]", [], "[agent=cursor]"],
		["description [agent=gemini]", [], "[agent=gemini]"],
		["description [model=gpt-5.5]", [], "[model=gpt-5.5]"],
		["agent label codex", ["codex"], undefined],
		["agent label cursor", ["Cursor"], undefined],
		["agent label opencode", ["opencode"], undefined],
		["provider/model label", ["openai/gpt-5.5"], undefined],
		["opencode provider label", ["opencode/openai/gpt-5.5"], undefined],
		["model label", ["gemini-2.5-pro"], undefined],
	])("%s", (_name, labels, description) => {
		const log = logger();
		const out = svc(only, log).determineRunnerSelection(
			labels as string[],
			description,
		);
		expect(out).toEqual({ runnerType: "claude" });
		expect(log.info).toHaveBeenCalledTimes(1);
		const line = String(log.info.mock.calls[0]?.[0]);
		expect(line).toContain("allowedRunners");
		expect(line).toContain('"claude"');
	});

	it("is unchanged when allowedRunners is absent", () => {
		const s = svc();
		expect(s.determineRunnerSelection([], "[agent=codex]").runnerType).toBe(
			"codex",
		);
		expect(s.determineRunnerSelection(["cursor"]).runnerType).toBe("cursor");
		expect(s.determineRunnerSelection(["opencode"]).runnerType).toBe(
			"opencode",
		);
		expect(s.isRunnerAllowed("gemini")).toBe(true);
	});

	it("keeps an allowed runner, with its model override", () => {
		const s = svc({ allowedRunners: ["claude", "codex"] });
		expect(
			s.determineRunnerSelection([], "[agent=codex][model=gpt-5.5]"),
		).toMatchObject({ runnerType: "codex", modelOverride: "gpt-5.5" });
		expect(s.determineRunnerSelection([], "[agent=gemini]").runnerType).toBe(
			"claude",
		);
	});

	it("falls back to the FIRST allowed runner", () => {
		expect(
			svc({ allowedRunners: ["codex", "claude"] }).determineRunnerSelection([
				"cursor",
			]).runnerType,
		).toBe("codex");
	});

	it("coerces the default runner", () => {
		expect(
			svc({
				allowedRunners: ["claude"],
				defaultRunner: "claude",
			}).getDefaultRunner(),
		).toBe("claude");
		// (EdgeWorker refuses this combination at startup; the service still
		// never hands out a forbidden runner.)
		expect(
			svc({
				allowedRunners: ["claude"],
				defaultRunner: "codex",
			}).getDefaultRunner(),
		).toBe("claude");
		expect(svc({ defaultRunner: "codex" }).getDefaultRunner()).toBe("codex");
	});
});

describe("validateAllowedRunners", () => {
	it("rejects a defaultRunner outside the list", () => {
		expect(
			validateAllowedRunners({
				allowedRunners: ["claude"],
				defaultRunner: "codex",
			}),
		).toEqual(['defaultRunner "codex" is not in allowedRunners']);
	});
	it("accepts consistent and absent configs", () => {
		expect(validateAllowedRunners({})).toEqual([]);
		expect(validateAllowedRunners({ defaultRunner: "codex" })).toEqual([]);
		expect(
			validateAllowedRunners({
				allowedRunners: ["claude", "codex"],
				defaultRunner: "codex",
			}),
		).toEqual([]);
	});
});

describe("RunnerConfigBuilder honours allowedRunners (issue, PR and child sessions share buildIssueConfig; chat has its own)", () => {
	const builderFor = (cfg: Partial<EdgeWorkerConfig>) =>
		new RunnerConfigBuilder(
			{ buildChatAllowedTools: () => [] },
			{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
			svc(cfg),
		);
	const issueInput = (session: Record<string, unknown>, extra = {}) => ({
		session: {
			issueId: "i",
			issue: { identifier: "ENG-1" },
			workspace: { path: "/w/ENG-1", isGitWorktree: true },
			...session,
		} as unknown as KittuAgentSession,
		repository: {
			id: "r",
			name: "r",
			repositoryPath: "/r",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "s",
		systemPrompt: "t",
		allowedTools: [],
		allowedDirectories: [],
		disallowedTools: [],
		kittuHome: "/tmp/home",
		linearWorkspaceId: "ws",
		logger: logger(),
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws",
		...extra,
	});

	it("issue sessions: a codex label becomes claude", () => {
		const { runnerType } = builderFor({
			allowedRunners: ["claude"],
		}).buildIssueConfig(issueInput({}, { labels: ["codex"] }));
		expect(runnerType).toBe("claude");
		expect(
			builderFor({}).buildIssueConfig(issueInput({}, { labels: ["codex"] }))
				.runnerType,
		).toBe("codex");
	});

	it("a session that ran on a now-forbidden runner continues on claude with a fresh session id", () => {
		const out = builderFor({ allowedRunners: ["claude"] }).buildIssueConfig(
			issueInput(
				{ codexSessionId: "codex-thread" },
				{ resumeSessionId: "codex-thread" },
			),
		);
		expect(out.runnerType).toBe("claude");
		expect(
			(out.config as { resumeSessionId?: string }).resumeSessionId,
		).toBeUndefined();
		// unrestricted: it resumes on codex as before
		const same = builderFor({}).buildIssueConfig(
			issueInput(
				{ codexSessionId: "codex-thread" },
				{ resumeSessionId: "codex-thread" },
			),
		);
		expect(same.runnerType).toBe("codex");
		expect((same.config as { resumeSessionId?: string }).resumeSessionId).toBe(
			"codex-thread",
		);
	});

	it("chat sessions: a resumed codex chat becomes claude and drops its resume id", () => {
		const chat = (cfg: Partial<EdgeWorkerConfig>) =>
			builderFor(cfg).buildChatConfig({
				workspacePath: "/tmp/ws",
				workspaceName: "w",
				systemPrompt: "t",
				sessionId: "s",
				kittuHome: "/tmp/home",
				platformName: "slack",
				logger: logger(),
				onMessage: () => {},
				onError: () => {},
				runnerType: "codex",
				resumeSessionId: "codex-thread",
			}) as unknown as { runnerType: RunnerType; resumeSessionId?: string };
		const restricted = chat({ allowedRunners: ["claude"] });
		expect(restricted.runnerType).toBe("claude");
		expect(restricted.resumeSessionId).toBeUndefined();
		const open = chat({});
		expect(open.runnerType).toBe("codex");
		expect(open.resumeSessionId).toBe("codex-thread");
	});

	it("chat sessions: the default runner is coerced", () => {
		const cfg = builderFor({
			allowedRunners: ["claude"],
			defaultRunner: "claude",
		}).buildChatConfig({
			workspacePath: "/tmp/ws",
			workspaceName: "w",
			systemPrompt: "t",
			sessionId: "s",
			kittuHome: "/tmp/home",
			platformName: "slack",
			logger: logger(),
			onMessage: () => {},
			onError: () => {},
		}) as unknown as { runnerType: RunnerType };
		expect(cfg.runnerType).toBe("claude");
	});
});

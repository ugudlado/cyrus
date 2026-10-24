import type { ILogger, KittuAgentSession, RepositoryConfig } from "kittu-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function build(opts: {
	sandboxEnabled: boolean;
	ghTokenDirs?: string[];
	githubTokenRoot?: string;
	sandboxWritablePaths?: string[];
	runnerType?: "claude" | "codex";
}) {
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] } as IChatToolResolver,
		{
			buildMcpConfig: () => ({}),
			buildMergedMcpConfigPath: () => undefined,
		} as IMcpConfigProvider,
		{
			determineRunnerSelection: () => ({
				runnerType: opts.runnerType ?? "claude",
			}),
			getDefaultModelForRunner: () => "model",
			getDefaultFallbackModelForRunner: () => "fallback",
		} as IRunnerSelector,
	);
	const { config } = builder.buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/wt/ABC-1", isGitWorktree: true },
		} as unknown as KittuAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/home/me/.kittu/ABC-1/attachments"],
		ghTokenDirs: opts.ghTokenDirs,
		githubTokenRoot: opts.githubTokenRoot,
		disallowedTools: ["WebSearch"],
		kittuHome: "/home/me/.kittu",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		sandboxWritablePaths: opts.sandboxWritablePaths,
		...(opts.sandboxEnabled ? { sandboxSettings: { enabled: true } } : {}),
	});
	return config as Record<string, any>;
}

const tokenDirs = [
	"/home/me/.kittu/gh-tokens/acme/widgets",
	"/home/me/.kittu/gh-tokens/acme/gadgets",
];

describe("RunnerConfigBuilder sandbox (clone per session)", () => {
	it("writes only the clone; reads the clone, attachments and exactly the session's token dirs", () => {
		const config = build({ sandboxEnabled: true, ghTokenDirs: tokenDirs });
		expect(config.sandbox.filesystem).toEqual({
			allowRead: [".", "/home/me/.kittu/ABC-1/attachments", ...tokenDirs],
			denyRead: ["~/"],
			allowWrite: ["/wt/ABC-1"],
		});
	});

	it("grants no token dir when none are given (feature off or clone failed)", () => {
		const config = build({ sandboxEnabled: true });
		expect(config.sandbox.filesystem.allowRead).toEqual([
			".",
			"/home/me/.kittu/ABC-1/attachments",
		]);
		expect(config.sandbox.filesystem.allowWrite).toEqual(["/wt/ABC-1"]);
	});

	it("keeps writablePaths readable and writable alongside token dirs", () => {
		const config = build({
			sandboxEnabled: true,
			ghTokenDirs: tokenDirs.slice(0, 1),
			sandboxWritablePaths: ["/home/me/.supabase"],
		});
		expect(config.sandbox.filesystem.allowRead).toEqual([
			".",
			"/home/me/.kittu/ABC-1/attachments",
			"/home/me/.supabase",
			tokenDirs[0],
		]);
		expect(config.sandbox.filesystem.allowWrite).toEqual([
			"/wt/ABC-1",
			"/home/me/.supabase",
		]);
	});

	it("denies the Read tool on the token root in the double-slash absolute form", () => {
		const config = build({
			sandboxEnabled: true,
			githubTokenRoot: "/home/me/.kittu/gh-tokens",
		});
		expect(config.disallowedTools).toEqual([
			"WebSearch",
			"Read(//home/me/.kittu/gh-tokens/**)",
		]);
		expect(build({ sandboxEnabled: true }).disallowedTools).toEqual([
			"WebSearch",
		]);
	});

	it("gives Codex the same token dirs and no shared repository", () => {
		const config = build({
			sandboxEnabled: true,
			runnerType: "codex",
			ghTokenDirs: tokenDirs,
		});
		expect(config.sandboxSettings).toEqual({
			allowWrite: ["/wt/ABC-1"],
			allowRead: [
				"/wt/ABC-1",
				"/home/me/.kittu/ABC-1/attachments",
				...tokenDirs,
			],
		});
	});

	it("does nothing without the sandbox", () => {
		const config = build({ sandboxEnabled: false, ghTokenDirs: tokenDirs });
		expect(config.sandbox).toBeUndefined();
	});
});

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
	gitMetadataDirectories?: string[];
	sandboxWritablePaths?: string[];
}) {
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] } as IChatToolResolver,
		{
			buildMcpConfig: () => ({}),
			buildMergedMcpConfigPath: () => undefined,
		} as IMcpConfigProvider,
		{
			determineRunnerSelection: () => ({ runnerType: "claude" }),
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
		allowedDirectories: [
			"/home/me/.kittu/ABC-1/attachments",
			"/repos/repo-a",
			"/repos/repo-a/.git",
			"/repos/repo-a/.git/worktrees/ABC-1",
		],
		gitMetadataDirectories: opts.gitMetadataDirectories,
		disallowedTools: [],
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

describe("RunnerConfigBuilder sandbox git metadata", () => {
	it("makes the worktree and the common .git writable, and keeps them out of allowRead", () => {
		const config = build({
			sandboxEnabled: true,
			gitMetadataDirectories: ["/repos/repo-a/.git"],
		});

		expect(config.sandbox.filesystem).toEqual({
			// worktree + attachments dir only: no repo path, no git metadata dirs
			allowRead: [".", "/home/me/.kittu/ABC-1/attachments"],
			denyRead: ["~/"],
			allowWrite: ["/wt/ABC-1", "/repos/repo-a/.git"],
		});
	});

	it("leaves allowedDirectories (tool-permission layer) unchanged", () => {
		const config = build({
			sandboxEnabled: true,
			gitMetadataDirectories: ["/repos/repo-a/.git"],
		});
		expect(config.allowedDirectories).toEqual([
			"/home/me/.kittu/ABC-1/attachments",
			"/repos/repo-a",
			"/repos/repo-a/.git",
			"/repos/repo-a/.git/worktrees/ABC-1",
		]);
	});

	it("keeps writablePaths readable and writable alongside git metadata dirs", () => {
		const config = build({
			sandboxEnabled: true,
			gitMetadataDirectories: ["/repos/repo-a/.git"],
			sandboxWritablePaths: ["/home/me/.supabase"],
		});
		expect(config.sandbox.filesystem.allowRead).toEqual([
			".",
			"/home/me/.kittu/ABC-1/attachments",
			"/home/me/.supabase",
		]);
		expect(config.sandbox.filesystem.allowWrite).toEqual([
			"/wt/ABC-1",
			"/repos/repo-a/.git",
			"/home/me/.supabase",
		]);
	});

	it("grants no git write access when no validated directories are given", () => {
		const config = build({ sandboxEnabled: true });
		expect(config.sandbox.filesystem.allowWrite).toEqual(["/wt/ABC-1"]);
	});

	it("does nothing without the sandbox", () => {
		const config = build({
			sandboxEnabled: false,
			gitMetadataDirectories: ["/repos/repo-a/.git"],
		});
		expect(config.sandbox).toBeUndefined();
	});
});

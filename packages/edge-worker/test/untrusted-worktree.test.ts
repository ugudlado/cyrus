import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";
import type { EdgeWorkerConfig } from "../src/types.js";
import {
	isUntrustedWorktreeEnabled,
	UNTRUSTED_WORKTREE_ENV,
} from "../src/untrustedWorktree.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

const startupMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
	const actual = await importOriginal<any>();
	return { ...actual, startup: (...args: any[]) => startupMock(...args) };
});

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

describe("isUntrustedWorktreeEnabled", () => {
	it("is off by default", () => {
		expect(isUntrustedWorktreeEnabled({})).toBe(false);
		expect(isUntrustedWorktreeEnabled({ [UNTRUSTED_WORKTREE_ENV]: "" })).toBe(
			false,
		);
		expect(isUntrustedWorktreeEnabled({ [UNTRUSTED_WORKTREE_ENV]: "0" })).toBe(
			false,
		);
	});

	it("is on for 1 and true", () => {
		expect(isUntrustedWorktreeEnabled({ [UNTRUSTED_WORKTREE_ENV]: "1" })).toBe(
			true,
		);
		expect(
			isUntrustedWorktreeEnabled({ [UNTRUSTED_WORKTREE_ENV]: " TRUE " }),
		).toBe(true);
	});
});

describe("RunnerConfigBuilder untrustedWorktree", () => {
	const build = (untrustedWorktree?: boolean) => {
		const builder = new RunnerConfigBuilder(
			{ buildChatAllowedTools: () => [] } as any,
			{
				buildMcpConfig: () => ({}),
				buildMergedMcpConfigPath: () => undefined,
			} as any,
			{
				determineRunnerSelection: () => ({ runnerType: "claude" }),
				getDefaultModelForRunner: () => "m",
				getDefaultFallbackModelForRunner: () => "f",
				getDefaultRunner: () => "claude",
			} as any,
			untrustedWorktree === undefined ? undefined : { untrustedWorktree },
		);
		const issue = builder.buildIssueConfig({
			session: {
				issueId: "i",
				issue: { identifier: "ABC-1" },
				workspace: { path: "/wt", isGitWorktree: true },
			} as unknown as CyrusAgentSession,
			repository: {
				id: "r",
				name: "r",
				repositoryPath: "/repo",
				allowedTools: [],
			} as unknown as RepositoryConfig,
			sessionId: "s",
			systemPrompt: "t",
			allowedTools: [],
			allowedDirectories: [],
			disallowedTools: [],
			cyrusHome: "/home/.cyrus",
			linearWorkspaceId: "w",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "w",
		}).config as Record<string, unknown>;
		const chat = builder.buildChatConfig({
			workspacePath: "/chat",
			workspaceName: "chat",
			systemPrompt: "t",
			sessionId: "s",
			cyrusHome: "/home/.cyrus",
			platformName: "slack",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		} as any) as Record<string, unknown>;
		return { issue, chat };
	};

	it("does not set the flag by default", () => {
		const { issue, chat } = build();
		expect(issue.untrustedWorktree).toBeUndefined();
		expect(chat.untrustedWorktree).toBeUndefined();
	});

	it("propagates the flag to issue and chat runner configs when on", () => {
		const { issue, chat } = build(true);
		expect(issue.untrustedWorktree).toBe(true);
		expect(chat.untrustedWorktree).toBe(true);
	});
});

describe("EdgeWorker untrusted-worktree mode", () => {
	let dir: string;
	let saved: string | undefined;

	const makeWorker = () => {
		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: join(dir, "repo"),
					workspaceBaseDir: join(dir, "wts"),
					linearWorkspaceId: "ws",
					baseBranch: "main",
				},
			],
			linearWorkspaces: { ws: { linearToken: "t" } },
		} as EdgeWorkerConfig;
		return new EdgeWorker(config);
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cyrus-untrusted-"));
		saved = process.env[UNTRUSTED_WORKTREE_ENV];
		startupMock.mockReset();
		startupMock.mockResolvedValue({});
	});

	afterEach(() => {
		if (saved === undefined) delete process.env[UNTRUSTED_WORKTREE_ENV];
		else process.env[UNTRUSTED_WORKTREE_ENV] = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the worktree .claude/settings.local.json by default", async () => {
		delete process.env[UNTRUSTED_WORKTREE_ENV];
		await (makeWorker() as any).writeWorkspaceClaudeSettings(dir);
		expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(true);
	});

	it("does not write the worktree .claude/settings.local.json when on", async () => {
		process.env[UNTRUSTED_WORKTREE_ENV] = "1";
		await (makeWorker() as any).writeWorkspaceClaudeSettings(dir);
		expect(existsSync(join(dir, ".claude"))).toBe(false);
	});

	const warm = async (worker: any) => {
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-1",
			workspace: { path: dir, isGitWorktree: true },
			updatedAt: 1,
			issueContext: { issueIdentifier: "ABC-1" },
		};
		worker.agentSessionManager.getAllSessions = () => [session];
		worker.sessionRepositories.set("sess-1", "repo-1");
		await worker.warmupRecentSessions();
		expect(startupMock).toHaveBeenCalledTimes(1);
		return startupMock.mock.calls[0][0].options;
	};

	it("warmup keeps settingSources user/project/local by default", async () => {
		delete process.env[UNTRUSTED_WORKTREE_ENV];
		const options = await warm(makeWorker());
		expect(options.settingSources).toEqual(["user", "project", "local"]);
	});

	it("warmup passes settingSources [] when on", async () => {
		process.env[UNTRUSTED_WORKTREE_ENV] = "1";
		const options = await warm(makeWorker());
		expect(options.settingSources).toEqual([]);
	});
});

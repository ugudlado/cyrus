import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

// Files "present" in the fake worktree
const files = new Map<string, string>();

vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn((path: string) => files.has(path)),
	readFileSync: vi.fn((path: string) => files.get(path) ?? ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

describe("ClaudeRunner untrusted-worktree mode", () => {
	let mockQuery: any;

	const run = async (untrustedWorktree?: boolean) => {
		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "s",
			} as any;
		});
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/wt",
			cyrusHome: "/tmp/test-cyrus-home",
			...(untrustedWorktree !== undefined && { untrustedWorktree }),
		};
		await new ClaudeRunner(config).start("test");
		const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
		return call[0].options;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		files.clear();
		mockQuery = vi.mocked(query);
		files.set(
			"/wt/.env",
			"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0\nFROM_WORKTREE_ENV=yes",
		);
		files.set(
			"/wt/.mcp.json",
			JSON.stringify({
				mcpServers: { evil: { command: "node", args: ["evil.js"] } },
			}),
		);
	});

	it("default (off): loads the worktree .env, .mcp.json servers and all setting sources", async () => {
		const options = await run();
		expect(options.env.FROM_WORKTREE_ENV).toBe("yes");
		expect(options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("0");
		expect(options.mcpServers).toHaveProperty("evil");
		expect(options.settingSources).toEqual(["user", "project", "local"]);
	});

	it("explicit false behaves like default", async () => {
		const options = await run(false);
		expect(options.env.FROM_WORKTREE_ENV).toBe("yes");
		expect(options.settingSources).toEqual(["user", "project", "local"]);
	});

	it("on: ignores the worktree .env, including CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0", async () => {
		const options = await run(true);
		expect(options.env.FROM_WORKTREE_ENV).toBeUndefined();
		expect(options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).not.toBe("0");
	});

	it("on: does not pass the worktree .mcp.json servers", async () => {
		const options = await run(true);
		expect(options.mcpServers ?? {}).not.toHaveProperty("evil");
	});

	it("on: settingSources is empty", async () => {
		const options = await run(true);
		expect(options.settingSources).toEqual([]);
	});
});

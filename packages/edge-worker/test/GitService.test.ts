import { execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import type { GitEnv } from "../src/gitEnv.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	lstatSync: vi.fn(),
	renameSync: vi.fn(),
	statfsSync: vi.fn(() => ({ bavail: 1e9, bsize: 4096 })),
	realpathSync: Object.assign(
		vi.fn((p: string) => p),
		{ native: vi.fn((p: string) => p) },
	),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	readdirSync: vi.fn(() => []),
	rmSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock("../src/WorktreeIncludeService.js", () => ({
	WorktreeIncludeService: vi.fn().mockImplementation(function () {
		return {
			copyIgnoredFiles: vi.fn().mockResolvedValue(undefined),
		};
	}),
}));

const mockExecSync = vi.mocked(execSync);

/**
 * GitService runs git through GitEnv (argv, pinned env). These unit tests stub
 * the process layer: every git call is rendered as `git <argv>`
 * and routed to mockExecSync, so the dispatchers below can match on it (non-flag operands quoted, as before). The
 * pinning itself is covered by GitEnv.test.ts / GitEnv.evil-gitdir.test.ts.
 */
const stubAdminNames = new Map<string, string>();
const stubGitEnv = {
	repoScope: (repoPath: string) => ({ cwd: repoPath, env: {} }),
	plainScope: (cwd: string) => ({ cwd, env: {} }),
	cloneScope: (ws: string) => ({ cwd: ws, env: {} }),
	assertCloneShape: (ws: string) => ({ workTree: ws, gitDir: `${ws}/.git` }),
	restampCloneConfig: () => {},
	run: (inv: { cwd: string }, args: string[]) => {
		const bare = new Set([
			"rev-parse",
			"worktree",
			"list",
			"add",
			"remove",
			"fetch",
			"ls-remote",
			"config",
			"update-ref",
			"merge-base",
			"origin",
			"clone",
			"checkout",
		]);
		const rendered = args
			.map((a) => (a.startsWith("-") || bare.has(a) ? a : `"${a}"`))
			.join(" ");
		const out = mockExecSync(`git ${rendered}`, {
			cwd: inv.cwd,
		} as never);
		return out === undefined || out === null ? "" : String(out);
	},
	trustedRemoteUrl: () => "https://example.test/o/r.git",
	listAdminDirs: () => [] as string[],
	resolveAdminName: (repo: string, ws: string) =>
		stubAdminNames.get(`${repo}|${ws}`) ?? stubAdminNames.get(ws) ?? null,
} as unknown as GitEnv;
const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

const mockSuccessfulSpawn = (stdout = "", stderr = "") => {
	mockSpawn.mockImplementation(() => {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		setImmediate(() => {
			if (stdout) child.stdout.emit("data", Buffer.from(stdout));
			if (stderr) child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", 0, null);
		});
		return child;
	});
};

const mockFailedSpawn = (opts: {
	code?: number | null;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
}) => {
	mockSpawn.mockImplementation(() => {
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		setImmediate(() => {
			if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
			if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
			child.emit("close", opts.code ?? 1, opts.signal ?? null);
		});
		return child;
	});
};

describe("GitService", () => {
	let gitService: GitService;
	const mockLogger: any = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		stubAdminNames.clear();
		// By default nothing exists on disk (lstat throws), like a fresh machine.
		vi.mocked(lstatSync).mockImplementation(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		delete process.env.CYRUS_WORKTREES_DIR;
		delete process.env.SECRET_TOKEN;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		mockSuccessfulSpawn();
		gitService = new GitService(
			{ cyrusHome: "/home/user/.cyrus", gitEnv: stubGitEnv },
			mockLogger,
		);
	});

	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
		delete process.env.SECRET_TOKEN;
		vi.restoreAllMocks();
	});

	describe("constructor", () => {
		it("defaults to cyrusHome/worktrees when workspaceBaseDir is omitted", async () => {
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/custom-cyrus-home/worktrees/DEF-123",
			);

			await fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/custom-cyrus-home/worktrees/DEF-123"),
			);
		});

		it("prefers CYRUS_WORKTREES_DIR over cyrusHome defaults", async () => {
			process.env.CYRUS_WORKTREES_DIR = "/tmp/env-worktrees";
			const fallbackGitService = new GitService(
				{ cyrusHome: "/tmp/custom-cyrus-home" },
				mockLogger,
			);

			mockExistsSync.mockImplementation(
				(path) => String(path) === "/tmp/env-worktrees/DEF-123",
			);

			await fallbackGitService.deleteWorktree("DEF-123");

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/env-worktrees/DEF-123"),
			);
		});

		it("dynamically reflects CYRUS_WORKTREES_DIR changes at runtime", async () => {
			const dynamicGitService = new GitService(
				{ cyrusHome: "/tmp/cyrus" },
				mockLogger,
			);

			// First call uses default cyrusHome (no env var set)
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);
			await dynamicGitService.deleteWorktree("ISSUE-1");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/tmp/cyrus/worktrees/ISSUE-1"),
			);

			mockLogger.info.mockClear();

			// Update env var at runtime — same GitService instance picks it up
			process.env.CYRUS_WORKTREES_DIR = "/new/runtime/path";
			await dynamicGitService.deleteWorktree("ISSUE-2");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("/new/runtime/path/ISSUE-2"),
			);
		});
	});

	// Shared helpers for test data
	const makeIssue = (overrides: Partial<any> = {}): any => ({
		id: "issue-1",
		identifier: "ENG-97",
		title: "Fix the shader",
		description: null,
		url: "",
		branchName: "cyrustester/eng-97-fix-shader",
		assigneeId: null,
		stateId: null,
		teamId: null,
		labelIds: [],
		priority: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		archivedAt: null,
		state: Promise.resolve(undefined),
		assignee: Promise.resolve(undefined),
		team: Promise.resolve(undefined),
		parent: Promise.resolve(undefined),
		project: Promise.resolve(undefined),
		labels: () => Promise.resolve({ nodes: [] }),
		comments: () => Promise.resolve({ nodes: [] }),
		attachments: () => Promise.resolve({ nodes: [] }),
		children: () => Promise.resolve({ nodes: [] }),
		inverseRelations: () => Promise.resolve({ nodes: [] }),
		update: () =>
			Promise.resolve({ success: true, issue: undefined, lastSyncId: 0 }),
		...overrides,
	});

	const makeRepository = (overrides: Partial<any> = {}): any => ({
		id: "repo-1",
		name: "test-repo",
		repositoryPath: "/home/user/repo",
		workspaceBaseDir: "/home/user/.cyrus/worktrees",
		baseBranch: "main",
		...overrides,
	});

	describe("createGitWorktree - repo setup hook discovery", () => {
		const setupSuccessfulWorktreeCreate = () => {
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-97-fix-shader"',
					)
				) {
					throw new Error("branch not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123\trefs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("cyrus-setup.sh")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});
		};

		it("runs setup from the worktree when the persistent checkout lacks cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return false;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				if (
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.isGitWorktree).toBe(true);
			expect(mockExecSync).toHaveBeenCalledWith(
				'bash "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"',
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/ENG-97",
					stdio: "inherit",
					env: expect.objectContaining({
						LINEAR_ISSUE_ID: "issue-1",
						LINEAR_ISSUE_IDENTIFIER: "ENG-97",
						LINEAR_ISSUE_TITLE: "Fix the shader",
					}),
				}),
			);
			expect(
				mockExecSync.mock.calls.some(
					([command]) =>
						String(command) === 'bash "/home/user/repo/cyrus-setup.sh"',
				),
			).toBe(false);
		});

		it("runs the worktree setup version when the persistent checkout also has cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return true;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				if (
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				throw new Error(`unexpected stat: ${String(path)}`);
			});

			await gitService.createGitWorktree(issue, [repository]);

			const setupCommands = mockExecSync.mock.calls
				.map(([command]) => String(command))
				.filter((command) => command.includes("cyrus-setup.sh"));
			expect(setupCommands).toEqual([
				'bash "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"',
			]);
		});

		it("skips repo setup without failing worktree creation when the worktree lacks cyrus-setup.sh", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/repo/cyrus-setup.sh") return true;
				if (p === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh")
					return false;
				return false;
			});

			const result = await gitService.createGitWorktree(issue, [repository]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(true);
			expect(
				mockSpawn.mock.calls.some(([command, args]) =>
					[command, ...(Array.isArray(args) ? args : [])].some((part) =>
						String(part).includes("cyrus-setup.sh"),
					),
				),
			).toBe(false);
		});

		it("emits repo setup start and success events with duration", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockSuccessfulSpawn("ready\n");

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({
				status: "started",
				issueIdentifier: "ENG-97",
				scriptName: "cyrus-setup.sh",
				repositoryName: "test-repo",
			});
			expect(events[1]).toMatchObject({
				status: "succeeded",
				issueIdentifier: "ENG-97",
				scriptName: "cyrus-setup.sh",
				repositoryName: "test-repo",
			});
			expect(events[1].durationMs).toEqual(expect.any(Number));
			expect(events[1].stdoutTail).toBeUndefined();
			expect(events[1].stderrTail).toBeUndefined();
		});

		it("emits repo setup failure events without failing worktree creation", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockFailedSpawn({
				code: 42,
				stdout: "installing deps\n",
				stderr: "missing package\n",
			});

			const result = await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(result.isGitWorktree).toBe(true);
			expect(events.map((event) => event.status)).toEqual([
				"started",
				"failed",
			]);
			expect(events[1]).toMatchObject({
				scriptName: "cyrus-setup.sh",
				exitCode: 42,
				errorMessage: "Script exited with code 42",
				stdoutTail: "installing deps",
				stderrTail: "missing package",
			});
		});

		it("runs repo setup shell hooks when they are not executable", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o644, isFile: () => false } as any);
			mockSuccessfulSpawn("setup complete\n");

			const result = await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(result.isGitWorktree).toBe(true);
			expect(mockSpawn).toHaveBeenCalledWith(
				"bash",
				["/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh"],
				expect.anything(),
			);
			expect(events.map((event) => event.status)).toEqual([
				"started",
				"succeeded",
			]);
			expect(events[1]).toMatchObject({
				issueIdentifier: "ENG-97",
				scriptName: "cyrus-setup.sh",
				repositoryName: "test-repo",
			});
			expect(events[1].durationMs).toEqual(expect.any(Number));
		});

		it("truncates repo setup failure output tails", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			const longStdout = Array.from(
				{ length: 45 },
				(_, index) => `stdout line ${index}`,
			).join("\n");
			mockFailedSpawn({ stdout: longStdout });

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			expect(events[1].stdoutTail).not.toContain("stdout line 0");
			expect(events[1].stdoutTail).toContain("stdout line 44");
			expect(events[1].truncated).toBe(true);
		});

		it("redacts secrets, environment values, and local paths from failure output", async () => {
			const issue = makeIssue();
			const repository = makeRepository();
			const events: any[] = [];
			process.env.SECRET_TOKEN = "super-secret-value";
			setupSuccessfulWorktreeCreate();
			mockExistsSync.mockImplementation(
				(path: any) =>
					String(path) === "/home/user/.cyrus/worktrees/ENG-97/cyrus-setup.sh",
			);
			mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => false } as any);
			mockFailedSpawn({
				stdout:
					"SECRET_TOKEN=super-secret-value\npath=/home/user/.cyrus/worktrees/ENG-97/config\nalias=/private/home/user/.cyrus/worktrees/ENG-97/config\n",
				stderr: "Bearer abcdefghijklmnopqrstuvwxyz123456\n",
			});

			await gitService.createGitWorktree(issue, [repository], {
				onRepoSetupHookEvent: (event) => events.push(event),
			});

			const failed = events[1];
			const visibleOutput = `${failed.stdoutTail}\n${failed.stderrTail}`;
			expect(visibleOutput).not.toContain("super-secret-value");
			expect(visibleOutput).not.toContain("/home/user");
			expect(visibleOutput).not.toContain("/private");
			expect(visibleOutput).not.toContain(
				"Bearer abcdefghijklmnopqrstuvwxyz123456",
			);
			expect(visibleOutput).toContain("[REDACTED]");
			expect(visibleOutput).toContain("[workspace]");
		});
	});

	describe("deleteWorktree - teardown wiring", () => {
		const makeRepo = (id: string, name: string, repoPath: string): any => ({
			id,
			name,
			repositoryPath: repoPath,
			workspaceBaseDir: "/home/user/.cyrus/worktrees",
		});

		const setupSingleRepoFs = () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
		};

		it("runs cyrus-teardown.sh before worktree removal when present", async () => {
			setupSingleRepoFs();
			// Add the teardown script to filesystem mock
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});

			mockExecSync.mockReturnValue(Buffer.from(""));
			stubAdminNames.set("/home/user/.cyrus/worktrees/DEF-123", "DEF-123");

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			// Should run teardown with cwd set to workspace root (single-repo)
			expect(mockExecSync).toHaveBeenCalledWith(
				'bash "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh"',
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123",
					stdio: "inherit",
					env: expect.objectContaining({
						LINEAR_ISSUE_IDENTIFIER: "DEF-123",
					}),
				}),
			);

			// Teardown must run before the directory is removed (assert order); no
			// git command runs at all.
			const teardownOrder = mockExecSync.mock.invocationCallOrder.find(
				(_, index) =>
					String(mockExecSync.mock.calls[index]?.[0]).includes(
						"cyrus-teardown.sh",
					),
			);
			const rmOrder = mockRmSync.mock.invocationCallOrder[0];
			expect(teardownOrder).toBeDefined();
			expect(rmOrder).toBeDefined();
			expect(rmOrder!).toBeGreaterThan(teardownOrder!);
			expect(
				mockExecSync.mock.calls.some(([c]) => String(c).startsWith("git ")),
			).toBe(false);

			expect(mockRmSync).toHaveBeenCalled();
		});

		it("does not run teardown when cyrus-teardown.sh is absent, still deletes worktree", async () => {
			setupSingleRepoFs();
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
			expect(calls.some((c) => c.includes("cyrus-teardown"))).toBe(false);
			expect(mockRmSync).toHaveBeenCalled();
		});

		it("continues with worktree deletion when teardown fails", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr.includes("cyrus-teardown.sh")) {
					throw new Error("script blew up");
				}
				return Buffer.from("");
			});

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("teardown script failed"),
			);
			expect(mockRmSync).toHaveBeenCalled();
		});

		it("warns and skips when teardown script is not executable", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o644, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			const execCmds = mockExecSync.mock.calls.map((c) => String(c[0]));
			expect(execCmds.some((c) => c.includes("cyrus-teardown.sh"))).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not executable"),
			);
		});

		it("does not attempt teardown when workspace dir is missing", async () => {
			mockExistsSync.mockReturnValue(false);

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockExecSync).not.toHaveBeenCalled();
			expect(mockRmSync).not.toHaveBeenCalled();
		});

		it("multi-repo: runs both repos' teardowns with correct cwds", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (p.endsWith("cyrus-teardown.sh")) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			expect(mockExecSync).toHaveBeenCalledWith(
				'bash "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"',
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123/repo-a",
				}),
			);
			expect(mockExecSync).toHaveBeenCalledWith(
				'bash "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"',
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123/repo-b",
				}),
			);
		});

		it("multi-repo: only one repo has a teardown, the other is silently skipped", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				// Only repo-a has a teardown script
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			const teardownCalls = mockExecSync.mock.calls
				.map(([command]) => String(command))
				.filter((c) => c.includes("cyrus-teardown.sh"));
			expect(teardownCalls).toHaveLength(1);
			expect(teardownCalls[0]).toContain(
				"/home/user/.cyrus/worktrees/DEF-123/repo-a/",
			);
		});

		it("multi-repo: one teardown failing does not skip the other or block rmSync", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return false;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git")
					return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git")
					return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/repos/repo-b") return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/cyrus-teardown.sh"
				)
					return true;
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"
				)
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git" ||
					p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git"
				) {
					return { isFile: () => true } as any;
				}
				if (p.endsWith("cyrus-teardown.sh")) {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-a/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/repo-b/.git") {
					return "gitdir: /home/user/repos/repo-b/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockReaddirSync.mockReturnValue([
				{ name: "repo-a", isDirectory: () => true },
				{ name: "repo-b", isDirectory: () => true },
			] as any);

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr.includes("repo-a/cyrus-teardown.sh")) {
					throw new Error("script blew up");
				}
				return Buffer.from("");
			});

			await gitService.deleteWorktree("DEF-123", {
				repositories: [
					makeRepo("a", "repo-a", "/home/user/repos/repo-a"),
					makeRepo("b", "repo-b", "/home/user/repos/repo-b"),
				],
			});

			// repo-b's teardown was still attempted
			expect(mockExecSync).toHaveBeenCalledWith(
				'bash "/home/user/.cyrus/worktrees/DEF-123/repo-b/cyrus-teardown.sh"',
				expect.objectContaining({
					cwd: "/home/user/.cyrus/worktrees/DEF-123/repo-b",
				}),
			);
			// rmSync still ran
			expect(mockRmSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/DEF-123",
				{ recursive: true, force: true },
			);
		});

		it("does not run teardown when repositories option is empty", async () => {
			setupSingleRepoFs();
			// Add a teardown that WOULD run if discovered — none should be picked up
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockExecSync.mockReturnValue(Buffer.from(""));

			await gitService.deleteWorktree("DEF-123");

			const teardownCalls = mockExecSync.mock.calls
				.map((c) => String(c[0]))
				.filter((c) => c.includes("cyrus-teardown"));
			expect(teardownCalls).toHaveLength(0);
		});

		it("logs timeout message with '2 minutes' when teardown is SIGTERM'd", async () => {
			mockExistsSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") return true;
				if (p === "/home/user/repos/repo-a") return true;
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh")
					return true;
				return false;
			});
			mockStatSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return { isFile: () => true } as any;
				}
				if (p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh") {
					return { mode: 0o755, isFile: () => false } as any;
				}
				return { isFile: () => false } as any;
			});
			mockReadFileSync.mockImplementation((path: any) => {
				const p = String(path);
				if (p === "/home/user/.cyrus/worktrees/DEF-123/.git") {
					return "gitdir: /home/user/repos/repo-a/.git/worktrees/DEF-123";
				}
				return "";
			});
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr.includes("cyrus-teardown.sh")) {
					const error = new Error("Script execution timed out") as Error & {
						signal?: string;
					};
					error.signal = "SIGTERM";
					throw error;
				}
				return Buffer.from("");
			});

			await gitService.deleteWorktree("DEF-123", {
				repositories: [makeRepo("a", "repo-a", "/home/user/repos/repo-a")],
			});

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("timed out (exceeded 2 minutes)"),
			);
		});
	});

	describe("createGitWorktree - 0 repos", () => {
		it("creates a plain folder with no git worktree", async () => {
			const issue = makeIssue();

			const result = await gitService.createGitWorktree(issue, [], {
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
			});

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
			expect(result.repoPaths).toBeUndefined();
			expect(mockMkdirSync).toHaveBeenCalledWith(
				"/home/user/.cyrus/worktrees/ENG-97",
				{ recursive: true },
			);
		});

		it("throws if workspaceBaseDir is not provided with 0 repos", async () => {
			const issue = makeIssue();

			await expect(gitService.createGitWorktree(issue, [])).rejects.toThrow(
				"workspaceBaseDir is required",
			);
		});

		it("runs global setup script in the plain folder", async () => {
			const issue = makeIssue();

			// Mock existsSync to return true for the global script
			mockExistsSync.mockReturnValue(true);

			const result = await gitService.createGitWorktree(issue, [], {
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
				globalSetupScript: "/home/user/setup.sh",
			});

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(false);
		});
	});

	describe("createGitWorktree - N repos (multi-repo)", () => {
		it("creates parent folder with per-repo worktree subdirectories", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/cyrus-hosted",
			});

			// Mock git commands for both repos
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					// Branch doesn't exist (will create new)
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
			expect(result.isGitWorktree).toBe(true);
			expect(result.repoPaths).toBeDefined();
			expect(result.repoPaths!["repo-1"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus",
			);
			expect(result.repoPaths!["repo-2"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus-hosted",
			);
		});

		it("uses first repo workspaceBaseDir when no override", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
				workspaceBaseDir: "/home/user/.cyrus/worktrees",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/cyrus-hosted",
				workspaceBaseDir: "/other/base",
			});

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			// Parent path uses first repo's workspaceBaseDir
			expect(result.path).toBe("/home/user/.cyrus/worktrees/ENG-97");
		});

		it("falls back to plain directory for individual repo failures in N-repo mode", async () => {
			const issue = makeIssue();
			const repo1 = makeRepository({
				id: "repo-1",
				name: "cyrus",
				repositoryPath: "/home/user/cyrus",
			});
			const repo2 = makeRepository({
				id: "repo-2",
				name: "cyrus-hosted",
				repositoryPath: "/home/user/does-not-exist",
			});

			mockExecSync.mockImplementation((cmd: any, opts: any) => {
				const cmdStr = String(cmd);
				if (cmdStr === "git rev-parse --git-dir") {
					// Second repo is not a git repo
					if (opts?.cwd === "/home/user/does-not-exist") {
						throw new Error("Not a git directory");
					}
					return Buffer.from(".git\n");
				}
				if (cmdStr === "git worktree list --porcelain") {
					return "";
				}
				if (cmdStr.includes("git rev-parse --verify")) {
					throw new Error("not found");
				}
				if (cmdStr.includes("git fetch origin")) {
					return Buffer.from("");
				}
				if (cmdStr.includes("git ls-remote")) {
					return Buffer.from("abc123 refs/heads/main\n");
				}
				if (cmdStr.includes("git worktree add")) {
					return Buffer.from("");
				}
				return Buffer.from("");
			});

			const result = await gitService.createGitWorktree(issue, [repo1, repo2]);

			expect(result.repoPaths).toBeDefined();
			// First repo should have succeeded
			expect(result.repoPaths!["repo-1"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus",
			);
			// Second repo falls back to plain directory
			expect(result.repoPaths!["repo-2"]).toBe(
				"/home/user/.cyrus/worktrees/ENG-97/cyrus-hosted",
			);
		});
	});

	describe("determineBaseBranch", () => {
		it("returns default base branch when no graphite label and no parent", async () => {
			const issue = makeIssue();
			const repository = makeRepository();

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("main");
			expect(result.source).toBe("default");
		});

		it("uses parent branch when parent exists", async () => {
			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent-issue",
				}),
			});
			const repository = makeRepository();

			// Mock branchExists to return true for parent branch
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-96-parent-issue"',
					)
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-96-parent-issue");
			expect(result.source).toBe("parent-issue");
			expect(result.detail).toContain("ENG-96");
		});

		it("uses blocking issue branch when graphite label is present (priority over parent)", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking issue",
				branchName: "cyrustester/eng-95-blocking",
			};

			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent",
				}),
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository();

			// Mock branchExists to return true for blocking branch
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes(
						'git rev-parse --verify "cyrustester/eng-95-blocking"',
					)
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-95-blocking");
			expect(result.source).toBe("graphite-blocked-by");
			expect(result.detail).toContain("ENG-95");
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("blocking issue branch"),
			);
		});

		it("falls back to parent when blocking branch does not exist", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking issue",
				branchName: "cyrustester/eng-95-blocking",
			};

			const issue = makeIssue({
				parent: Promise.resolve({
					identifier: "ENG-96",
					title: "Parent issue",
					branchName: "cyrustester/eng-96-parent",
				}),
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository();

			// Mock branchExists: blocking branch doesn't exist, parent does
			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (
					cmdStr.includes('git rev-parse --verify "cyrustester/eng-96-parent"')
				) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("cyrustester/eng-96-parent");
			expect(result.source).toBe("parent-issue");
			expect(result.detail).toContain("ENG-96");
		});

		it("falls back to default when no graphite blockers and no parent", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
				// graphite label present but no blocking issues
				inverseRelations: () => Promise.resolve({ nodes: [] }),
			});
			const repository = makeRepository();

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("main");
			expect(result.source).toBe("default");
		});

		it("uses custom graphite label config", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocking",
				branchName: "eng-95-branch",
			};

			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "custom-graphite" }],
					}),
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
						],
					}),
			});
			const repository = makeRepository({
				labelPrompts: {
					graphite: { labels: ["custom-graphite"] },
				},
			});

			mockExecSync.mockImplementation((cmd: any) => {
				const cmdStr = String(cmd);
				if (cmdStr.includes('git rev-parse --verify "eng-95-branch"')) {
					return Buffer.from("abc123\n");
				}
				throw new Error("not found");
			});

			const result = await gitService.determineBaseBranch(issue, repository);

			expect(result.branch).toBe("eng-95-branch");
			expect(result.source).toBe("graphite-blocked-by");
			expect(result.detail).toContain("ENG-95");
		});
	});

	describe("hasGraphiteLabel", () => {
		it("returns true when issue has graphite label", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "graphite" }],
					}),
			});
			const repository = makeRepository();

			const result = await gitService.hasGraphiteLabel(issue, repository);

			expect(result).toBe(true);
		});

		it("returns false when issue does not have graphite label", async () => {
			const issue = makeIssue({
				labels: () =>
					Promise.resolve({
						nodes: [{ name: "bug" }],
					}),
			});
			const repository = makeRepository();

			const result = await gitService.hasGraphiteLabel(issue, repository);

			expect(result).toBe(false);
		});
	});

	describe("fetchBlockingIssues", () => {
		it("returns blocking issues from inverse relations", async () => {
			const blockingIssue = {
				identifier: "ENG-95",
				title: "Blocker",
			};
			const issue = makeIssue({
				inverseRelations: () =>
					Promise.resolve({
						nodes: [
							{
								type: "blocks",
								issue: Promise.resolve(blockingIssue),
							},
							{
								type: "related",
								issue: Promise.resolve({ identifier: "ENG-94" }),
							},
						],
					}),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(1);
			expect(result[0]!.identifier).toBe("ENG-95");
		});

		it("returns empty array when no inverse relations", async () => {
			const issue = makeIssue({
				inverseRelations: () => Promise.resolve({ nodes: [] }),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(0);
		});

		it("returns empty array when inverse relations fails", async () => {
			const issue = makeIssue({
				inverseRelations: () => Promise.reject(new Error("network error")),
			});

			const result = await gitService.fetchBlockingIssues(issue);

			expect(result).toHaveLength(0);
		});
	});
});

describe("GitService untrusted-worktree mode (hook scripts)", () => {
	const silentLog: any = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	};
	const hookFs = () => {
		mockExistsSync.mockImplementation((path: any) => {
			const p = String(path);
			return (
				p === "/home/user/.cyrus/worktrees/DEF-123" ||
				p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-teardown.sh" ||
				p === "/home/user/.cyrus/worktrees/DEF-123/cyrus-setup.sh"
			);
		});
		mockStatSync.mockImplementation(
			() => ({ mode: 0o755, isFile: () => false }) as any,
		);
		mockExecSync.mockReturnValue(Buffer.from(""));
	};
	const repo: any = {
		id: "a",
		name: "repo-a",
		repositoryPath: "/home/user/repos/repo-a",
		workspaceBaseDir: "/home/user/.cyrus/worktrees",
	};
	const ranHook = () =>
		mockExecSync.mock.calls.some((c) =>
			/cyrus-(setup|teardown)/.test(String(c[0])),
		);

	beforeEach(() => {
		vi.clearAllMocks();
		hookFs();
	});

	it("runs cyrus-teardown.sh when the flag is off", async () => {
		const svc = new GitService({ cyrusHome: "/home/user/.cyrus" }, silentLog);
		await svc.deleteWorktree("DEF-123", { repositories: [repo] });
		expect(ranHook()).toBe(true);
	});

	it("does not run cyrus-teardown.sh when the flag is on, but still removes the worktree", async () => {
		const svc = new GitService(
			{ cyrusHome: "/home/user/.cyrus", untrustedWorktree: true },
			silentLog,
		);
		await svc.deleteWorktree("DEF-123", { repositories: [repo] });
		expect(ranHook()).toBe(false);
		expect(mockRmSync).toHaveBeenCalled();
	});

	it("does not run cyrus-setup.sh when the flag is on", async () => {
		const svc = new GitService(
			{ cyrusHome: "/home/user/.cyrus", untrustedWorktree: true },
			silentLog,
		);
		await (svc as any).runRepoSetupScript(
			"/home/user/.cyrus/worktrees/DEF-123",
			{ id: "i", identifier: "DEF-123", title: "t" },
			"repo-a",
		);
		expect(ranHook()).toBe(false);
	});

	it("runs cyrus-setup.sh when the flag is off", async () => {
		const svc = new GitService({ cyrusHome: "/home/user/.cyrus" }, silentLog);
		await (svc as any).runRepoSetupScript(
			"/home/user/.cyrus/worktrees/DEF-123",
			{ id: "i", identifier: "DEF-123", title: "t" },
			"repo-a",
		);
		expect(ranHook()).toBe(true);
	});
});

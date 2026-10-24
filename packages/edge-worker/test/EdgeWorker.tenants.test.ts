import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { CloneFailedError, EdgeWorker } from "../src/EdgeWorker.js";
import { GitService } from "../src/GitService.js";
import { SessionGit } from "../src/gitEnv.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { expectedRoutingBlock } from "./helpers/routingBlock.js";
import { makeSessionFixture } from "./helpers/sessionGitFixture.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/AgentSessionManager.js");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

const repo = (id: string, ws: string): RepositoryConfig => ({
	id,
	name: id,
	repositoryPath: `/repos/${id}`,
	workspaceBaseDir: "/workspaces",
	baseBranch: "main",
	linearWorkspaceId: ws,
	isActive: true,
});

const tenant = (id: string, repositoryIds: string[]) => ({
	id,
	linearWorkspaceId: `ws-${id}`,
	linear: {
		clientIdEnv: `CID_${id}`,
		clientSecretEnv: `CSEC_${id}`,
		webhookSecretEnv: `WH_${id}`,
	},
	repositoryIds,
});

function makeConfig(over: Partial<EdgeWorkerConfig> = {}): EdgeWorkerConfig {
	return {
		proxyUrl: "http://localhost:3000",
		cyrusHome: TEST_CYRUS_HOME,
		repositories: [
			repo("jus", "ws-a"),
			repo("cyr", "ws-a"),
			repo("lap", "ws-b"),
		],
		linearWorkspaces: {
			"ws-a": { linearToken: "t-a" },
			"ws-b": { linearToken: "t-b" },
		},
		tenants: [tenant("a", ["jus", "cyr"]), tenant("b", ["lap"])],
		handlers: {
			createWorkspace: vi
				.fn()
				.mockResolvedValue({ path: "/w", isGitWorktree: false }),
		},
		...over,
	} as EdgeWorkerConfig;
}

describe("EdgeWorker tenants", () => {
	let transportConfig: any;
	let listeners: Record<string, (...args: any[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "true");
		vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");
		vi.stubEnv("WH_a", "secret-a");
		vi.stubEnv("WH_b", "secret-b");
		listeners = {};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				createCyrusAgentSession: vi.fn(),
				getSessionsByIssueId: vi.fn().mockReturnValue([]),
				serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
				restoreState: vi.fn(),
				on: vi.fn(),
			} as any;
		});
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi
					.fn()
					.mockReturnValue(new Proxy({}, { get: () => vi.fn() })),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			} as any;
		});
		vi.mocked(LinearEventTransport).mockImplementation(function (cfg: any) {
			transportConfig = cfg;
			return {
				register: vi.fn(),
				on: vi.fn((event: string, fn: (...args: any[]) => void) => {
					listeners[event] = fn;
				}),
				removeAllListeners: vi.fn(),
			} as any;
		});
		vi.mocked(LinearClient).mockImplementation(function () {
			return { users: { me: vi.fn().mockResolvedValue({ id: "u" }) } } as any;
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("requires direct webhooks and an external host when tenants are configured", () => {
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "false");
		expect(() => new EdgeWorker(makeConfig())).toThrow(
			/LINEAR_DIRECT_WEBHOOKS is not "true"/,
		);
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "true");
		vi.stubEnv("CYRUS_HOST_EXTERNAL", "");
		expect(() => new EdgeWorker(makeConfig())).toThrow(
			/CYRUS_HOST_EXTERNAL is not "true"/,
		);
	});

	it("refuses a defaultRunner outside allowedRunners", () => {
		expect(
			() =>
				new EdgeWorker(
					makeConfig({
						allowedRunners: ["claude"],
						defaultRunner: "codex",
					} as Partial<EdgeWorkerConfig>),
				),
		).toThrow(/defaultRunner "codex" is not in allowedRunners/);
	});

	it("does not require those env vars without tenants", () => {
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "");
		vi.stubEnv("CYRUS_HOST_EXTERNAL", "");
		expect(
			() => new EdgeWorker(makeConfig({ tenants: undefined })),
		).not.toThrow();
	});

	it("warns with the repo id only when a repository belongs to no tenant", () => {
		const out: string[] = [];
		for (const m of ["log", "warn", "error", "info"] as const) {
			vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
				out.push(a.join(" "));
			});
		}
		new EdgeWorker(
			makeConfig({
				repositories: [
					repo("jus", "ws-a"),
					repo("cyr", "ws-a"),
					repo("lap", "ws-b"),
					repo("orphan", "ws-b"),
				],
			}),
		);
		const lines = out.filter((l) => l.includes("belongs to no tenant"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("orphan");
	});

	it("hands handleWebhook only the matched tenant's repositories", async () => {
		const worker = new EdgeWorker(makeConfig());
		const handleWebhook = vi
			.spyOn(worker as any, "handleWebhook")
			.mockResolvedValue(undefined);
		await (worker as any).initializeComponents();

		expect(transportConfig.tenantSecrets.map((t: any) => t.tenantId)).toEqual([
			"a",
			"b",
		]);
		expect(transportConfig.tenantSecrets[0].getSecret()).toBe("secret-a");

		const payload = { type: "AgentSessionEvent", organizationId: "ws-a" };
		listeners.event(payload, "a");
		expect(handleWebhook).toHaveBeenCalledTimes(1);
		expect(handleWebhook.mock.calls[0][1].map((r: any) => r.id)).toEqual([
			"jus",
			"cyr",
		]);

		listeners.event({ ...payload, organizationId: "ws-b" }, "b");
		expect(handleWebhook.mock.calls[1][1].map((r: any) => r.id)).toEqual([
			"lap",
		]);
	});

	describe("tenant-scoped chat prompts", () => {
		const withUrl = (id: string, ws: string, url: string) => ({
			...repo(id, ws),
			githubUrl: url,
		});
		const configWithUrls = () =>
			makeConfig({
				repositories: [
					withUrl("jus", "ws-a", "https://github.com/org-a/app"),
					withUrl("cyr", "ws-a", "https://github.com/org-a/app-two"),
					withUrl("lap", "ws-b", "https://github.com/org-b/solo"),
				],
			});

		it("builds a tenant's chat routing context from its own repositories; untagged and unknown get nothing", () => {
			const worker = new EdgeWorker(configWithUrls());
			const ctx = (id?: string) => (worker as any).chatRoutingContext(id);
			// Tenant order (jus, cyr); the representative repository is first by name.
			expect(ctx("a")).toBe(
				expectedRoutingBlock([
					{ name: "jus", githubUrl: "https://github.com/org-a/app" },
					{
						name: "cyr",
						githubUrl: "https://github.com/org-a/app-two",
						current: true,
					},
				]),
			);
			// Single-repo tenant: no routing needed. Unknown / untagged: nothing.
			expect(ctx("b")).toBe("");
			expect(ctx("ghost")).toBe("");
			expect(ctx(undefined)).toBe("");
		});

		it("without tenants the chat routing context is the unscoped one", () => {
			const cfg = configWithUrls();
			const worker = new EdgeWorker({
				...cfg,
				tenants: undefined,
				repositories: cfg.repositories.map((r) => ({
					...r,
					linearWorkspaceId: "ws-a",
				})),
			} as EdgeWorkerConfig);
			const out = (worker as any).chatRoutingContext(undefined);
			expect(out).toContain("https://github.com/org-a/app-two");
			expect(out).toContain("https://github.com/org-b/solo");
		});

		it("reposForWorkspace returns only the owning tenant's repositories", () => {
			const worker = new EdgeWorker(makeConfig());
			const ids = (ws: string) =>
				(worker as any).reposForWorkspace(ws).map((r: any) => r.id);
			expect(ids("ws-a")).toEqual(["jus", "cyr"]);
			expect(ids("ws-b")).toEqual(["lap"]);
			expect(ids("ws-unknown")).toEqual([]);
			expect((worker as any).reposForTenant(undefined)).toEqual([]);
		});

		it("does not register Zulip when tenants are configured, and warns naming env vars only", () => {
			vi.stubEnv("ZULIP_SITE", "https://zulip.example.test");
			vi.stubEnv("ZULIP_BOT_EMAIL", "bot@example.test");
			vi.stubEnv("ZULIP_API_KEY", "zulip-secret-value");
			vi.stubEnv("ZULIP_WEBHOOK_TOKEN", "zulip-token-value");
			const worker = new EdgeWorker(makeConfig());
			const warn = vi.spyOn((worker as any).logger, "warn");
			(worker as any).registerZulipEventTransport();
			expect((worker as any).zulipEventTransport).toBeNull();
			expect((worker as any).zulipChatSessionHandler).toBeNull();
			expect(warn).toHaveBeenCalledOnce();
			const message = String(warn.mock.calls[0]?.[0]);
			expect(message).toContain("ZULIP_SITE");
			expect(message).not.toContain("zulip-secret-value");
			expect(message).not.toContain("zulip-token-value");
		});

		it("does not register the shared Slack transport when no tenant has a slack section", () => {
			const worker = new EdgeWorker(makeConfig());
			const warn = vi.spyOn((worker as any).logger, "warn");
			(worker as any).registerSlackEventTransport();
			expect((worker as any).slackEventTransport).toBeNull();
			expect((worker as any).chatSessionHandler).toBeNull();
			expect(String(warn.mock.calls[0]?.[0])).toContain(
				"Slack event transport not registered",
			);
			expect(String(warn.mock.calls[0]?.[0])).toContain("CYRUS_HOST_EXTERNAL");
		});

		describe("restored sessions and clone failures", () => {
			let fx: ReturnType<typeof makeSessionFixture>;
			beforeEach(() => {
				fx = makeSessionFixture();
			});
			afterEach(() => fx.cleanup());

			const workerFor = (guardBytes = 0) => {
				const base = makeConfig();
				const cfg = {
					...base,
					handlers: undefined,
					repositories: [
						{
							...repo("jus", "ws-a"),
							repositoryPath: fx.repo,
							workspaceBaseDir: join(fx.root, "worktrees"),
						},
						repo("cyr", "ws-a"),
						repo("lap", "ws-b"),
					],
				} as unknown as EdgeWorkerConfig;
				const worker = new EdgeWorker(cfg);
				(worker as any).gitService = new GitService(
					{
						cyrusHome: join(fx.root, "home"),
						gitAllowFileProtocol: true,
						cloneMinFreeBytes: guardBytes,
					},
					(worker as any).logger,
				);
				const post = vi
					.spyOn((worker as any).activityPoster, "postErrorActivity")
					.mockResolvedValue(undefined);
				vi.spyOn(worker as any, "savePersistedState").mockResolvedValue(
					undefined,
				);
				return { worker, post };
			};
			const restored = (workspace: Record<string, unknown>) =>
				({
					id: "s1",
					issueId: "i1",
					issue: {
						id: "i1",
						identifier: "ENG-1",
						title: "t",
						branchName: "main",
					},
					repositories: [{ repositoryId: "jus", branchName: "main" }],
					workspace: { path: fx.ws, isGitWorktree: true, ...workspace },
				}) as any;

			it("a restored session whose workspace is still a legacy worktree gets a fresh clone, valid cwd and git targets", async () => {
				const { worker } = workerFor();
				const session = restored({ gitDirNames: { jus: "ENG-1" } });
				const primary = (worker as any).repositories.get("jus");
				expect(lstatSync(join(fx.ws, ".git")).isFile()).toBe(true);

				await (worker as any).ensureSessionClone(session, primary, "ws-a");

				expect(session.workspace.path).toBe(fx.ws);
				expect(lstatSync(join(fx.ws, ".git")).isDirectory()).toBe(true);
				expect(session.workspace.gitDirNames).toBeUndefined();
				expect(session.workspace.branchNames).toEqual({ jus: "main" });
				expect(
					readdirSync(join(fx.root, "worktrees")).some((n) =>
						n.startsWith("ENG-1.worktree-old-"),
					),
				).toBe(true);
				// the runner's git targets resolve to the new clone
				const targets = (worker as any).buildGitSessionTargets(
					session,
					primary,
				);
				const inv = new SessionGit(
					(worker as any).gitService.gitEnv,
					targets,
				).invocationFor(fx.ws);
				expect(inv?.env.GIT_DIR).toBe(inv?.env.GIT_COMMON_DIR);
			});

			it("a missing workspace directory gets a fresh clone; a healthy clone is left alone", async () => {
				const { worker } = workerFor();
				const primary = (worker as any).repositories.get("jus");
				rmSync(fx.ws, { recursive: true, force: true });
				const session = restored({});
				await (worker as any).ensureSessionClone(session, primary, "ws-a");
				expect(lstatSync(join(fx.ws, ".git")).isDirectory()).toBe(true);
				const spy = vi.spyOn((worker as any).gitService, "createGitWorktree");
				await (worker as any).ensureSessionClone(session, primary, "ws-a");
				expect(spy).not.toHaveBeenCalled();
			});

			it("a restored session whose clone fails the shape check is quarantined and re-cloned", async () => {
				const { worker } = workerFor();
				const primary = (worker as any).repositories.get("jus");
				const session = restored({});
				await (worker as any).ensureSessionClone(session, primary, "ws-a"); // legacy -> clone
				writeFileSync(join(fx.ws, "session-work.txt"), "mine\n");
				const target = join(fx.root, "elsewhere");
				mkdirSync(target);
				symlinkSync(target, join(fx.ws, ".git", "logs-link"));

				await (worker as any).ensureSessionClone(session, primary, "ws-a");

				expect(() =>
					(worker as any).gitService.gitEnv.assertCloneShape(fx.ws),
				).not.toThrow();
				expect(existsSync(join(fx.ws, "session-work.txt"))).toBe(false);
				const aside = readdirSync(join(fx.root, "worktrees")).filter((n) =>
					n.startsWith("ENG-1.quarantine-"),
				);
				expect(aside).toHaveLength(1);
				expect(
					readFileSync(
						join(fx.root, "worktrees", aside[0] as string, "session-work.txt"),
						"utf8",
					),
				).toBe("mine\n");
			});

			it("buildAgentRunnerConfig makes sure the clone exists before building the runner", async () => {
				const { worker } = workerFor();
				const ensure = vi
					.spyOn(worker as any, "ensureSessionClone")
					.mockRejectedValue(new Error("stop here"));
				await expect(
					(worker as any).buildAgentRunnerConfig(
						restored({}),
						(worker as any).repositories.get("jus"),
						"s1",
						undefined,
						[],
						[],
						[],
					),
				).rejects.toThrow("stop here");
				expect(ensure).toHaveBeenCalledOnce();
			});

			it("the startup cutover skips workspaces a session still uses", () => {
				const { worker } = workerFor();
				const migrate = vi
					.spyOn((worker as any).gitService, "migrateLegacyWorktrees")
					.mockReturnValue({ moved: [], dirty: [], invalid: [], inUse: [] });
				vi.spyOn((worker as any).gitService, "sweepWorkspaces").mockReturnValue(
					[],
				);
				vi.spyOn(worker as any, "getAllKnownSessions").mockReturnValue([
					{ workspace: { path: "/w/ENG-1" } },
				]);
				(worker as any).parkedSessions.set("i2", {
					agentSession: { issue: { identifier: "ENG-2" } },
				});
				(worker as any).startWorkspaceMaintenance();
				clearInterval((worker as any).workspaceSweepTimer);
				const isInUse = migrate.mock.calls[0]?.[0].isInUse as (
					p: string,
				) => boolean;
				expect(isInUse("/w/ENG-1")).toBe(true); // live session
				expect(isInUse("/w/ENG-2")).toBe(true); // parked session
				expect(isInUse("/w/ENG-3")).toBe(false);
			});

			it("single-repo clone failure (free-space guard): error activity naming repo and reason, no runner", async () => {
				const { worker, post } = workerFor(Number.MAX_SAFE_INTEGER);
				const primary = (worker as any).repositories.get("jus");
				rmSync(fx.ws, { recursive: true, force: true });
				const session = restored({});
				await expect(
					(worker as any).ensureSessionClone(session, primary, "ws-a"),
				).rejects.toBeInstanceOf(CloneFailedError);
				expect(post).toHaveBeenCalledOnce();
				const [sessionId, workspaceId, body] = post.mock.calls[0] as string[];
				expect(sessionId).toBe("s1");
				expect(workspaceId).toBe("ws-a");
				expect(body).toContain("jus");
				expect(body).toContain("not enough free disk space");
				expect(body).toContain("The session was not started");
				expect(body).not.toContain(fx.root);
				// the failure is recorded, so the next prompt retries
				expect(session.workspace.cloneFailed).toEqual(["jus"]);
				expect(session.workspace.isGitWorktree).toBe(false);
			});

			it("multi-repo clone failure: activity posted, session continues, prompt lists the failed repos", async () => {
				const { worker, post } = workerFor();
				const repos = ["jus", "cyr"].map((id) =>
					(worker as any).repositories.get(id),
				);
				await (worker as any).reportCloneFailure(
					"s1",
					"ws-a",
					{
						cloneFailed: ["cyr"],
						cloneFailures: { cyr: "not a git repository" },
					},
					repos,
				);
				expect(post).toHaveBeenCalledOnce();
				expect(String(post.mock.calls[0]?.[2])).toContain(
					"Continuing without git for that repository",
				);
				vi.spyOn(worker as any, "buildContinuationPrompt").mockReturnValue({
					userPrompt: "hello",
					metadata: { components: [], promptType: "continuation" },
				});
				const out = await (worker as any).assemblePrompt({
					session: { workspace: { cloneFailed: ["cyr"] } },
					isStreaming: false,
					isNewSession: false,
				});
				expect(out.userPrompt).toBe(
					"hello\n\n<clone_failures>\nGit is not available for these repositories (their clone failed; the directories are empty plain folders): cyr\n</clone_failures>",
				);
				// no failure: the prompt is untouched
				const clean = await (worker as any).assemblePrompt({
					session: { workspace: {} },
					isStreaming: false,
					isNewSession: false,
				});
				expect(clean.userPrompt).toBe("hello");
			});
		});

		it("findRepositoryByGitLabUrl matches the exact trailing project path only", () => {
			const cfg = configWithUrls();
			const worker = new EdgeWorker({
				...cfg,
				repositories: [
					{
						...cfg.repositories[0],
						gitlabUrl: "https://gitlab.com/grp/sub/app",
					},
					{
						...cfg.repositories[1],
						gitlabUrl: "https://gitlab.com/grp/sub/app-two.git",
					},
					cfg.repositories[2],
				],
			} as EdgeWorkerConfig);
			const find = (path: string) =>
				(worker as any).findRepositoryByGitLabUrl(path)?.id ?? null;
			expect(find("grp/sub/app")).toBe("jus");
			expect(find("GRP/Sub/App-Two")).toBe("cyr");
			expect(find("sub/app")).toBe("jus");
			expect(find("grp/sub/ap")).toBeNull();
			expect(find("b/app")).toBeNull();
		});

		describe("clone-per-session wiring", () => {
			const cfg = () => {
				const base = configWithUrls();
				return {
					...base,
					githubTokenDir: "/home/me/.kittu/gh-tokens",
				} as EdgeWorkerConfig;
			};
			const session = (workspace: Record<string, unknown>) =>
				({ workspace }) as never;

			it("grants exactly the session's repositories' token dirs (lowercase owner/name)", () => {
				const worker = new EdgeWorker(cfg());
				const dirs = (workspace: Record<string, unknown>, primary = "jus") =>
					(worker as any).buildGhTokenDirs(
						session(workspace),
						(worker as any).repositories.get(primary),
					);
				// single-repo session: only its own repo
				expect(dirs({ path: "/w/ENG-1", isGitWorktree: true })).toEqual([
					"/home/me/.kittu/gh-tokens/org-a/app",
				]);
				// multi-repo: each repo whose clone succeeded; the failed one gets none
				expect(
					dirs({
						path: "/w/ENG-1",
						isGitWorktree: true,
						repoPaths: {
							jus: "/w/ENG-1/jus",
							cyr: "/w/ENG-1/cyr",
							lap: "/w/ENG-1/lap",
						},
						cloneFailed: ["cyr"],
					}),
				).toEqual([
					"/home/me/.kittu/gh-tokens/org-a/app",
					"/home/me/.kittu/gh-tokens/org-b/solo",
				]);
				// a plain-directory (clone failed) workspace gets none
				expect(
					dirs({
						path: "/w/ENG-1",
						isGitWorktree: false,
						cloneFailed: ["jus"],
					}),
				).toEqual([]);
			});

			it("grants nothing when githubTokenDir is unset", () => {
				const worker = new EdgeWorker(configWithUrls());
				expect(
					(worker as any).buildGhTokenDirs(
						session({ path: "/w", isGitWorktree: true }),
						(worker as any).repositories.get("jus"),
					),
				).toEqual([]);
			});

			it("names PR clones with the repository so two repos' PR 5 never collide", async () => {
				const worker = new EdgeWorker(configWithUrls());
				const create = vi
					.spyOn((worker as any).gitService, "createGitWorktree")
					.mockResolvedValue({ path: "/w/x", isGitWorktree: true });
				const repos = (worker as any).repositories;
				await (worker as any).createGitHubWorkspace(repos.get("jus"), "b", 5);
				await (worker as any).createGitHubWorkspace(repos.get("lap"), "b", 5);
				expect(create.mock.calls.map((c: any) => c[0].identifier)).toEqual([
					"jus-PR-5",
					"lap-PR-5",
				]);
			});

			it("treats a workspace as in use when any session references it", () => {
				const worker = new EdgeWorker(configWithUrls());
				vi.spyOn(worker as any, "getAllKnownSessions").mockReturnValue([
					{
						workspace: {
							path: "/w/jus-PR-5",
							repoPaths: { a: "/w/lap-PR-9/a" },
						},
					},
				]);
				expect((worker as any).isWorkspaceInUse("/w/jus-PR-5")).toBe(true);
				expect((worker as any).isWorkspaceInUse("/w/lap-PR-9")).toBe(true);
				expect((worker as any).isWorkspaceInUse("/w/jus-PR-50")).toBe(false);
			});
		});

		it("findRepositoryByGitHubUrl matches the exact trailing owner/repo only", () => {
			const worker = new EdgeWorker(configWithUrls());
			const find = (name: string) =>
				(worker as any).findRepositoryByGitHubUrl(name)?.id ?? null;
			expect(find("org-a/app")).toBe("jus");
			expect(find("ORG-A/App-Two")).toBe("cyr");
			expect(find("org-a/app.git")).toBe("jus");
			expect(find("org-a/ap")).toBeNull();
			expect(find("g-a/app")).toBeNull();
			expect(find("other/app")).toBeNull();
		});
	});
});

import { LinearClient } from "@linear/sdk";
import { LinearEventTransport } from "kittu-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { expectedRoutingBlock } from "./helpers/routingBlock.js";
import { TEST_KITTU_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("@linear/sdk");
vi.mock("kittu-linear-event-transport");
vi.mock("../src/AgentSessionManager.js");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("kittu-core", async (importOriginal) => {
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
		kittuHome: TEST_KITTU_HOME,
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
		vi.stubEnv("KITTU_HOST_EXTERNAL", "true");
		vi.stubEnv("WH_a", "secret-a");
		vi.stubEnv("WH_b", "secret-b");
		listeners = {};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				createKittuAgentSession: vi.fn(),
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
		vi.stubEnv("KITTU_HOST_EXTERNAL", "");
		expect(() => new EdgeWorker(makeConfig())).toThrow(
			/KITTU_HOST_EXTERNAL is not "true"/,
		);
	});

	it("does not require those env vars without tenants", () => {
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "");
		vi.stubEnv("KITTU_HOST_EXTERNAL", "");
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
			expect(String(warn.mock.calls[0]?.[0])).toContain("KITTU_HOST_EXTERNAL");
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

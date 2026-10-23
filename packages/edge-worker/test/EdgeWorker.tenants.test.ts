import { LinearClient } from "@linear/sdk";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
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
});

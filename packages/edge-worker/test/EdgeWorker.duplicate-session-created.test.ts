import { LinearClient } from "@linear/sdk";
import type { LinearAgentSessionCreatedWebhook } from "cyrus-core";
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

describe("EdgeWorker - duplicate AgentSessionEvent.created deliveries", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			} as any;
		});

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			} as any;
		});

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123" }),
				},
			} as any;
		});

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("created handling", () => {
		const makeWebhook = (
			sessionId: string,
			issueId = "issue-123",
		): LinearAgentSessionCreatedWebhook =>
			({
				type: "AgentSessionEvent",
				action: "created",
				createdAt: "2026-10-21T21:54:56.000Z",
				organizationId: "test-workspace",
				agentSession: {
					id: sessionId,
					issue: {
						id: issueId,
						identifier: "TEST-14",
						title: "Some issue",
						description: "Do the thing",
					},
					comment: { id: "comment-1", body: "Do the thing" },
				},
			}) as LinearAgentSessionCreatedWebhook;

		let initializeSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			vi.spyOn(
				(edgeWorker as any).repositoryRouter,
				"determineRepositoryForWebhook",
			).mockResolvedValue({ type: "selected", repositories: [mockRepository] });
			vi.spyOn(
				edgeWorker as any,
				"checkBlockedByDependencies",
			).mockResolvedValue({
				blocked: false,
				blockingIssueIds: [],
				blockingIdentifiers: [],
			});
			vi.spyOn(
				edgeWorker as any,
				"linkChildSessionToParentIssueSession",
			).mockResolvedValue(undefined);
			initializeSpy = vi
				.spyOn(edgeWorker as any, "initializeAgentRunner")
				.mockImplementation(async () => {
					// Yield so concurrent deliveries interleave while "starting".
					await new Promise((r) => setTimeout(r, 5));
				});
		});

		const deliver = (webhook: LinearAgentSessionCreatedWebhook) =>
			(edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

		it("starts one runner when the same created event is delivered back-to-back", async () => {
			await deliver(makeWebhook("session-A"));
			await deliver(makeWebhook("session-A"));

			expect(initializeSpy).toHaveBeenCalledTimes(1);
		});

		it("starts one runner when the same created event is delivered concurrently", async () => {
			await Promise.all([
				deliver(makeWebhook("session-A")),
				deliver(makeWebhook("session-A")),
			]);

			expect(initializeSpy).toHaveBeenCalledTimes(1);
		});

		it("still handles a different agent session on the same issue", async () => {
			await Promise.all([
				deliver(makeWebhook("session-A")),
				deliver(makeWebhook("session-B")),
			]);

			expect(initializeSpy).toHaveBeenCalledTimes(2);
			const startedIds = initializeSpy.mock.calls.map((c: any[]) => c[0].id);
			expect(startedIds.sort()).toEqual(["session-A", "session-B"]);
		});

		it("handles a redelivery after the first handling failed early", async () => {
			initializeSpy.mockRejectedValueOnce(
				new Error("worktree creation failed"),
			);

			await expect(deliver(makeWebhook("session-A"))).rejects.toThrow(
				"worktree creation failed",
			);
			await deliver(makeWebhook("session-A"));

			expect(initializeSpy).toHaveBeenCalledTimes(2);
		});

		it("ignores a duplicate without posting any Linear activity", async () => {
			const postSpy = vi.spyOn(
				(edgeWorker as any).activityPoster,
				"postThoughtActivity",
			);
			await deliver(makeWebhook("session-A"));
			await deliver(makeWebhook("session-A"));

			expect(postSpy).not.toHaveBeenCalled();
		});

		it("still ignores a duplicate that arrives after a clean early return", async () => {
			vi.spyOn(
				(edgeWorker as any).repositoryRouter,
				"determineRepositoryForWebhook",
			).mockResolvedValue({
				type: "needs_selection",
				workspaceRepos: [mockRepository],
			});
			const elicitSpy = vi
				.spyOn(
					(edgeWorker as any).repositoryRouter,
					"elicitUserRepositorySelection",
				)
				.mockResolvedValue(undefined);

			await deliver(makeWebhook("session-A"));
			await deliver(makeWebhook("session-A"));

			expect(elicitSpy).toHaveBeenCalledTimes(1);
			expect(initializeSpy).not.toHaveBeenCalled();
		});

		it("bounds the number of remembered session ids", async () => {
			initializeSpy.mockResolvedValue(undefined);
			for (let i = 0; i < 1100; i++) {
				await deliver(makeWebhook(`session-${i}`));
			}
			expect(
				(edgeWorker as any).claimedSessionCreatedIds.size,
			).toBeLessThanOrEqual(1000);
		});
	});
});

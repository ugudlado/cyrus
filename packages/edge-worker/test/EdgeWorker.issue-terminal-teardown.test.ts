import { CLIIssueTrackerService } from "kittu-core";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

const makeMessage = (isDeleted = false): any => ({
	id: "m1",
	source: "linear",
	action: "issue_state_change",
	receivedAt: "2025-01-01T00:00:00Z",
	organizationId: "org-1",
	sessionKey: "issue-1",
	workItemId: "issue-1",
	workItemIdentifier: "TEST-1",
	isTerminal: true,
	platformData: {
		issue: { id: "issue-1", identifier: "TEST-1" },
		...(isDeleted ? { isDeleted: true } : {}),
	},
});

const makeWorker = (fetchIssue: ReturnType<typeof vi.fn> | undefined) => {
	const session = { id: "s1", agentRunner: { stop: vi.fn() } };
	const self: any = {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		issueTrackers: new Map(fetchIssue ? [["org-1", { fetchIssue }]] : []),
		agentSessionManager: {
			getSessionsByIssueId: vi.fn(() => [session]),
			requestSessionStop: vi.fn(),
			createResponseActivity: vi.fn(),
			removeSession: vi.fn(),
		},
		sessionRepositories: new Map(),
		repositories: new Map(),
		gitService: { deleteWorkspace: vi.fn() },
	};
	return self;
};

const run = (self: any, message: any) =>
	(EdgeWorker.prototype as any).handleIssueStateChangeMessage.call(
		self,
		message,
	);

const issueWithState = (type: string) =>
	vi.fn().mockResolvedValue({ state: Promise.resolve({ type }) });

describe("EdgeWorker.handleIssueStateChangeMessage state verification", () => {
	it.each([
		"completed",
		"canceled",
	])("tears down when state is %s", async (t) => {
		const self = makeWorker(issueWithState(t));
		await run(self, makeMessage());
		expect(self.gitService.deleteWorkspace).toHaveBeenCalledWith("TEST-1", {
			repositories: [],
		});
		expect(self.agentSessionManager.removeSession).toHaveBeenCalledWith("s1");
	});

	it.each([
		"started",
		"unstarted",
		"backlog",
	])("does nothing when state is %s", async (t) => {
		const self = makeWorker(issueWithState(t));
		await run(self, makeMessage());
		expect(self.gitService.deleteWorkspace).not.toHaveBeenCalled();
		expect(self.agentSessionManager.requestSessionStop).not.toHaveBeenCalled();
		expect(self.agentSessionManager.removeSession).not.toHaveBeenCalled();
	});

	it("fails safe (no teardown, logged) when the fetch fails", async () => {
		const self = makeWorker(vi.fn().mockRejectedValue(new Error("boom")));
		await run(self, makeMessage());
		expect(self.gitService.deleteWorkspace).not.toHaveBeenCalled();
		expect(self.logger.warn).toHaveBeenCalled();
	});

	it("fails safe when no issue tracker exists for the workspace", async () => {
		const self = makeWorker(undefined);
		await run(self, makeMessage());
		expect(self.gitService.deleteWorkspace).not.toHaveBeenCalled();
	});

	it("tears down a deleted issue without fetching its state", async () => {
		const fetchIssue = vi.fn();
		const self = makeWorker(fetchIssue);
		await run(self, makeMessage(true));
		expect(fetchIssue).not.toHaveBeenCalled();
		expect(self.gitService.deleteWorkspace).toHaveBeenCalled();
	});
});

describe("handleIssueStateChangeMessage with the real CLI issue tracker", () => {
	const setup = async () => {
		const tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		const issue = await tracker.createIssue({
			teamId: "team-default",
			title: "t",
			description: "",
		});
		const messages: any[] = [];
		const transport = tracker.createEventTransport({
			platform: "cli",
			fastifyServer: {} as any,
		});
		transport.on("message", (m: any) => messages.push(m));
		const self = makeWorker(undefined);
		self.issueTrackers.set("cli-workspace", tracker);
		return { tracker, issue, messages, self };
	};

	it("tears down after terminateIssue('completed')", async () => {
		const { tracker, issue, messages, self } = await setup();
		await tracker.terminateIssue(issue.id, "completed");
		await run(self, messages[0]);
		expect(self.gitService.deleteWorkspace).toHaveBeenCalledWith(
			issue.identifier,
			{ repositories: [] },
		);
	});

	it("tears down after terminateIssue('canceled')", async () => {
		const { tracker, issue, messages, self } = await setup();
		await tracker.terminateIssue(issue.id, "canceled");
		await run(self, messages[0]);
		expect(self.gitService.deleteWorkspace).toHaveBeenCalled();
	});

	it("tears down after terminateIssue('deleted')", async () => {
		const { tracker, issue, messages, self } = await setup();
		await tracker.terminateIssue(issue.id, "deleted");
		expect(messages[0].platformData.isDeleted).toBe(true);
		await run(self, messages[0]);
		expect(self.gitService.deleteWorkspace).toHaveBeenCalled();
	});

	it("does not tear down for a non-terminal CLI issue", async () => {
		const { issue, messages, self } = await setup();
		await run(self, {
			...makeMessage(),
			organizationId: "cli-workspace",
			workItemId: issue.id,
			workItemIdentifier: issue.identifier,
		});
		expect(self.gitService.deleteWorkspace).not.toHaveBeenCalled();
		expect(messages).toHaveLength(0);
	});
});

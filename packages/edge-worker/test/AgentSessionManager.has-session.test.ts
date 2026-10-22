import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

describe("AgentSessionManager.hasSession", () => {
	it("is true only for sessions restored from persisted state", () => {
		const logger: any = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			withContext: vi.fn().mockReturnThis(),
		};
		const manager = new AgentSessionManager(undefined, undefined, logger);
		expect(manager.hasSession("restored-session")).toBe(false);

		manager.restoreState(
			{
				"restored-session": {
					id: "restored-session",
					issueId: "issue-1",
					status: "active",
				} as any,
			},
			{},
		);

		expect(manager.hasSession("restored-session")).toBe(true);
		expect(manager.hasSession("other")).toBe(false);
	});
});

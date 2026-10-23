import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

function makeService(
	getSlackBotTokenForRepo?: (repoId: string) => string | undefined,
) {
	return new McpConfigService({
		// No Linear token => early "cli mode" return is NOT used; provide a client.
		getLinearTokenForWorkspace: () => "lin_token",
		getIssueTracker: () => ({ getClient: () => ({}) }) as any,
		getKittuToolsMcpUrl: () => "http://localhost:3456/mcp/kittu-tools",
		createKittuToolsOptions: () => ({}) as any,
		getSlackBotTokenForRepo,
	});
}

describe("McpConfigService Slack MCP token", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses SLACK_BOT_TOKEN when no tenant resolver is provided (unchanged)", () => {
		vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-global");
		const cfg = makeService().buildMcpConfig("repo-1", "ws-1", "s1");
		expect((cfg.slack as any).env.SLACK_MCP_XOXB_TOKEN).toBe("xoxb-global");
	});

	it("uses the repository's tenant token, never the global one", () => {
		vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-global");
		const svc = makeService((repoId) =>
			repoId === "lapse" ? "xoxb-lapse" : undefined,
		);
		expect(
			(svc.buildMcpConfig("lapse", "ws-1", "s1").slack as any).env
				.SLACK_MCP_XOXB_TOKEN,
		).toBe("xoxb-lapse");
		// A repo whose tenant has no Slack gets no Slack MCP server at all
		expect(svc.buildMcpConfig("jusplay", "ws-1", "s2").slack).toBeUndefined();
	});
});

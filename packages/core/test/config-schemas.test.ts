import { describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";
import { TenantRegistry, validateTenants } from "../src/tenants.js";

const baseRepository = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/path/to/repo",
	baseBranch: "main",
	workspaceBaseDir: "/workspaces",
};

describe("EdgeConfigSchema", () => {
	it("accepts strict MCP configuration as a top-level boolean", () => {
		const enabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: true,
		});
		const disabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: false,
		});

		expect(enabled.strictMcpConfig).toBe(true);
		expect(disabled.strictMcpConfig).toBe(false);
	});

	it("accepts arbitrary JSON-compatible OpenCode config at global and repository levels", () => {
		const config = {
			repositories: [
				{
					...baseRepository,
					opencode: {
						config: {
							model: "anthropic/claude-sonnet-4.5",
							disableCache: false,
							maxTokens: 12000,
							provider: null,
							experimental: {
								tools: ["bash", { name: "linear", enabled: true }],
							},
						},
					},
				},
			],
			opencode: {
				config: {
					theme: "system",
					autoshare: true,
					agent: {
						build: {
							description: "Build agent",
							temperature: 0.2,
						},
					},
					mcp: ["linear", "github"],
				},
			},
		};

		const result = EdgeConfigSchema.safeParse(config);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.opencode?.config).toEqual(config.opencode.config);
			expect(result.data.repositories[0]?.opencode?.config).toEqual(
				config.repositories[0].opencode.config,
			);
		}
	});

	it("rejects non-object OpenCode config at global and repository levels", () => {
		const globalResult = EdgeConfigSchema.safeParse({
			repositories: [baseRepository],
			opencode: { config: "anthropic/claude-sonnet-4.5" },
		});
		const repositoryResult = EdgeConfigSchema.safeParse({
			repositories: [
				{
					...baseRepository,
					opencode: { config: ["not", "an", "object"] },
				},
			],
		});

		expect(globalResult.success).toBe(false);
		expect(repositoryResult.success).toBe(false);
	});
});

describe("tenants", () => {
	const tenant = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		linearWorkspaceId: `ws-${id}`,
		linear: {
			clientIdEnv: `LINEAR_CLIENT_ID__${id}`,
			clientSecretEnv: `LINEAR_CLIENT_SECRET__${id}`,
			webhookSecretEnv: `LINEAR_WEBHOOK_SECRET__${id}`,
		},
		slack: {
			teamId: `T_${id}`,
			botTokenEnv: `SLACK_BOT_TOKEN__${id}`,
			signingSecretEnv: `SLACK_SIGNING_SECRET__${id}`,
		},
		repositoryIds: [`repo-${id}`],
		...over,
	});
	const repos = ["a", "b"].map((id) => ({
		...baseRepository,
		id: `repo-${id}`,
	}));

	it("is optional and parses a valid tenant list", () => {
		expect(EdgeConfigSchema.parse({ repositories: repos }).tenants).toBe(
			undefined,
		);
		const cfg = EdgeConfigSchema.parse({
			repositories: repos,
			tenants: [tenant("a"), tenant("b", { slack: undefined })],
		});
		expect(validateTenants(cfg)).toEqual([]);
	});

	it("reports duplicate ids, workspaces, teams and shared or missing repos", () => {
		const cfg = EdgeConfigSchema.parse({
			repositories: repos,
			tenants: [
				tenant("a"),
				tenant("a", {
					linearWorkspaceId: "ws-a",
					slack: tenant("a").slack,
					repositoryIds: ["repo-a", "nope"],
				}),
			],
		});
		const problems = validateTenants(cfg).join("\n");
		expect(problems).toContain('duplicate tenant id "a"');
		expect(problems).toContain("linearWorkspaceId already used");
		expect(problems).toContain("slack.teamId already used");
		expect(problems).toContain('repository "nope" does not exist');
	});

	it("rejects a repository owned by two tenants", () => {
		const cfg = EdgeConfigSchema.parse({
			repositories: repos,
			tenants: [tenant("a"), tenant("b", { repositoryIds: ["repo-a"] })],
		});
		expect(validateTenants(cfg).join()).toContain(
			'repository "repo-a" belongs to both "a" and "b"',
		);
	});

	it("TenantRegistry looks tenants up and reads secrets at call time", () => {
		const env: NodeJS.ProcessEnv = {};
		const reg = TenantRegistry.fromConfig(
			EdgeConfigSchema.parse({
				repositories: repos,
				tenants: [tenant("a"), tenant("b")],
			}),
			env,
		);
		expect(reg.enabled).toBe(true);
		expect(reg.byLinearWorkspaceId("ws-b")?.id).toBe("b");
		expect(reg.bySlackTeamId("T_a")?.id).toBe("a");
		expect(reg.byRepositoryId("repo-b")?.id).toBe("b");
		expect(reg.byId("zzz")).toBeUndefined();
		expect(reg.secret("X")).toBeUndefined();
		env.X = "v";
		expect(reg.secret("X")).toBe("v");
		expect(TenantRegistry.fromConfig({}).enabled).toBe(false);
	});
});

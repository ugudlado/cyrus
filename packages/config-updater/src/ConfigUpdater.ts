import type { FastifyInstance } from "fastify";
import { handleCheckGh } from "./handlers/checkGh.js";
import { handleCheckGlab } from "./handlers/checkGlab.js";
import { handleConfigureMcp } from "./handlers/configureMcp.js";
import { handleGitHubTokens } from "./handlers/githubTokens.js";
import { handleKittuConfig } from "./handlers/kittuConfig.js";
import { handleKittuEnv } from "./handlers/kittuEnv.js";
import {
	handleRepository,
	handleRepositoryDelete,
} from "./handlers/repository.js";
import {
	handleDeleteSkill,
	handleListSkills,
	handleUpdateSkill,
} from "./handlers/skills.js";
import { handleTestMcp } from "./handlers/testMcp.js";
import type {
	ApiResponse,
	CheckGhPayload,
	CheckGlabPayload,
	ConfigureMcpPayload,
	DeleteRepositoryPayload,
	DeleteSkillPayload,
	GitHubTokensPayload,
	KittuConfigPayload,
	KittuEnvPayload,
	ListSkillsPayload,
	RepositoryPayload,
	TestMcpPayload,
	UpdateSkillPayload,
} from "./types.js";

/**
 * ConfigUpdater registers configuration update routes with a Fastify server
 * Handles: kittu-config, kittu-env, repository, update/test-mcp, update/configure-mcp, check-gh endpoints
 *
 * `getApiKey` is invoked on every auth check, so callers reading from
 * `process.env.KITTU_API_KEY` pick up `.env` reloads (triggered by
 * `kittu auth` after a credential rotation) without restarting the process.
 */
export class ConfigUpdater {
	private fastify: FastifyInstance;
	private kittuHome: string;
	private getApiKey: () => string;

	constructor(
		fastify: FastifyInstance,
		kittuHome: string,
		getApiKey: () => string,
	) {
		this.fastify = fastify;
		this.kittuHome = kittuHome;
		this.getApiKey = getApiKey;
	}

	/**
	 * Register all configuration update routes with the Fastify instance
	 */
	register(): void {
		// Register all routes with authentication
		this.registerRoute("/api/update/kittu-config", this.handleKittuConfigRoute);
		this.registerRoute("/api/update/kittu-env", this.handleKittuEnvRoute);
		this.registerRoute("/api/update/repository", this.handleRepositoryRoute);
		this.registerDeleteRoute(
			"/api/update/repository",
			this.handleRepositoryDeleteRoute,
		);
		this.registerRoute("/api/update/test-mcp", this.handleTestMcpRoute);
		this.registerRoute(
			"/api/update/configure-mcp",
			this.handleConfigureMcpRoute,
		);
		this.registerRoute(
			"/api/update/github-tokens",
			this.handleGitHubTokensRoute,
		);
		this.registerRoute("/api/check-gh", this.handleCheckGhRoute);
		this.registerRoute("/api/check-glab", this.handleCheckGlabRoute);
		this.registerRoute("/api/update/skill", this.handleUpdateSkillRoute);
		this.registerDeleteRoute("/api/update/skill", this.handleDeleteSkillRoute);
		this.registerGetRoute("/api/skills", this.handleListSkillsRoute);
	}

	/**
	 * Register a route with authentication
	 */
	private registerRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.post(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.body);
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Register a DELETE route with authentication
	 */
	private registerDeleteRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.delete(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.body);
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Register a GET route with authentication
	 */
	private registerGetRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.get(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.query || {});
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Verify Bearer token authentication
	 */
	private verifyAuth(authHeader: string | undefined): boolean {
		const apiKey = this.getApiKey();
		if (!authHeader || !apiKey) {
			return false;
		}

		const expectedAuth = `Bearer ${apiKey}`;
		return authHeader === expectedAuth;
	}

	/**
	 * Handle kittu-config update
	 */
	private async handleKittuConfigRoute(
		payload: KittuConfigPayload,
	): Promise<ApiResponse> {
		const response = await handleKittuConfig(payload, this.kittuHome);

		// Emit restart event if requested
		if (response.success && response.data?.restartKittu) {
			this.fastify.log.info("Config update requested Kittu restart");
		}

		return response;
	}

	/**
	 * Handle kittu-env update
	 */
	private async handleKittuEnvRoute(
		payload: KittuEnvPayload,
	): Promise<ApiResponse> {
		const response = await handleKittuEnv(payload, this.kittuHome);

		// Emit restart event if requested
		if (response.success && response.data?.restartKittu) {
			this.fastify.log.info("Env update requested Kittu restart");
		}

		return response;
	}

	/**
	 * Handle repository clone/verify
	 */
	private async handleRepositoryRoute(
		payload: RepositoryPayload,
	): Promise<ApiResponse> {
		return handleRepository(payload, this.kittuHome);
	}

	/**
	 * Handle MCP connection test
	 */
	private async handleTestMcpRoute(
		payload: TestMcpPayload,
	): Promise<ApiResponse> {
		return handleTestMcp(payload);
	}

	/**
	 * Handle MCP server configuration
	 */
	private async handleConfigureMcpRoute(
		payload: ConfigureMcpPayload,
	): Promise<ApiResponse> {
		return handleConfigureMcp(payload, this.kittuHome);
	}

	/**
	 * Handle GitHub installation tokens push
	 */
	private async handleGitHubTokensRoute(
		payload: GitHubTokensPayload,
	): Promise<ApiResponse> {
		return handleGitHubTokens(payload, this.kittuHome);
	}

	/**
	 * Handle GitHub CLI check
	 */
	private async handleCheckGhRoute(
		payload: CheckGhPayload,
	): Promise<ApiResponse> {
		return handleCheckGh(payload, this.kittuHome);
	}

	/**
	 * Handle GitLab CLI check
	 */
	private async handleCheckGlabRoute(
		payload: CheckGlabPayload,
	): Promise<ApiResponse> {
		return handleCheckGlab(payload, this.kittuHome);
	}

	/**
	 * Handle repository deletion
	 */
	private async handleRepositoryDeleteRoute(
		payload: DeleteRepositoryPayload,
	): Promise<ApiResponse> {
		return handleRepositoryDelete(payload, this.kittuHome);
	}

	/**
	 * Handle creating or updating a user skill
	 */
	private async handleUpdateSkillRoute(
		payload: UpdateSkillPayload,
	): Promise<ApiResponse> {
		return handleUpdateSkill(payload, this.kittuHome);
	}

	/**
	 * Handle deleting a user skill
	 */
	private async handleDeleteSkillRoute(
		payload: DeleteSkillPayload,
	): Promise<ApiResponse> {
		return handleDeleteSkill(payload, this.kittuHome);
	}

	/**
	 * Handle listing user skills
	 */
	private async handleListSkillsRoute(
		payload: ListSkillsPayload,
	): Promise<ApiResponse> {
		return handleListSkills(payload, this.kittuHome);
	}
}

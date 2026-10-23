import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LinearClient } from "@linear/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import {
	DEFAULT_CONFIG_FILENAME,
	type EdgeConfig,
	migrateEdgeConfig,
} from "kittu-core";
import open from "open";
import { BaseCommand } from "./ICommand.js";

/**
 * Self-auth-linear command - authenticate with Linear OAuth directly from CLI
 * Handles the complete OAuth flow without requiring EdgeWorker
 */
export class SelfAuthCommand extends BaseCommand {
	private server: FastifyInstance | null = null;
	private callbackPort = parseInt(process.env.KITTU_SERVER_PORT || "3456", 10);

	/**
	 * @param options.tenant Authorize this tenant's own Linear OAuth app: its env
	 *   var names come from config.json `tenants` (or, before setup has written
	 *   the tenant, the NAME__SUFFIX rule: upper-case, '-' -> '_').
	 * @param options.expectSlug Refuse to save unless the authorized workspace's
	 *   urlKey equals this slug.
	 */
	async execute(
		_args: string[],
		options: { tenant?: string; expectSlug?: string } = {},
	): Promise<void> {
		console.log("\nKittu Linear Self-Authentication");
		this.logDivider();

		// Check config file exists
		const configPath = resolve(this.app.kittuHome, DEFAULT_CONFIG_FILENAME);
		const loadConfig = (): EdgeConfig => {
			try {
				return migrateEdgeConfig(
					JSON.parse(readFileSync(configPath, "utf-8")),
				) as EdgeConfig;
			} catch {
				this.logError(`Config file not found: ${configPath}`);
				console.log("Run 'kittu' first to create initial configuration.");
				process.exit(1);
			}
		};
		// Tenant env names live in the config; otherwise validate env first.
		let config: EdgeConfig | undefined = options.tenant
			? loadConfig()
			: undefined;

		// Resolve which env vars hold the OAuth app credentials
		const tenantId = options.tenant;
		const tenant = tenantId
			? config?.tenants?.find((t) => t.id === tenantId)
			: undefined;
		if (tenantId && !tenant && !/^[a-z0-9][a-z0-9-]*$/.test(tenantId)) {
			this.logError(`Invalid tenant id: ${tenantId}`);
			process.exit(1);
		}
		if (tenantId && !tenant && !options.expectSlug) {
			this.logError(
				`Tenant "${tenantId}" is not in config.json yet; pass --expect-slug <linear-workspace-slug> so the right workspace is authorized`,
			);
			process.exit(1);
		}
		const suffix = tenantId?.toUpperCase().replace(/-/g, "_");
		const clientIdEnv =
			tenant?.linear.clientIdEnv ??
			(suffix ? `LINEAR_CLIENT_ID__${suffix}` : "LINEAR_CLIENT_ID");
		const clientSecretEnv =
			tenant?.linear.clientSecretEnv ??
			(suffix ? `LINEAR_CLIENT_SECRET__${suffix}` : "LINEAR_CLIENT_SECRET");

		// Check required environment variables
		const clientId = process.env[clientIdEnv];
		const clientSecret = process.env[clientSecretEnv];
		const baseUrl = process.env.KITTU_BASE_URL;

		if (!clientId || !clientSecret || !baseUrl) {
			this.logError("Missing required environment variables:");
			if (!clientId) console.log(`   - ${clientIdEnv}`);
			if (!clientSecret) console.log(`   - ${clientSecretEnv}`);
			if (!baseUrl) console.log("   - KITTU_BASE_URL");
			console.log(`\nAdd these to your env file (${this.app.kittuHome}/.env):`);
			console.log(`  ${clientIdEnv}=your-client-id`);
			console.log(`  ${clientSecretEnv}=your-client-secret`);
			console.log("  KITTU_BASE_URL=https://your-tunnel-domain.com");
			process.exit(1);
		}

		config = config ?? loadConfig();

		console.log("Configuration:");
		if (tenantId) console.log(`   Tenant: ${tenantId}`);
		console.log(`   Base URL: ${baseUrl}`);
		console.log(`   Config: ${configPath}`);
		console.log(`   Callback port: ${this.callbackPort}`);
		console.log();

		try {
			if (process.env.CLOUDFLARE_TOKEN) {
				this.logger.info("Starting cloudflare tunnel...");

				const { SharedApplicationServer } = await import("kittu-edge-worker");
				const sharedApplicationServer = new SharedApplicationServer(
					this.callbackPort,
					baseUrl,
					false,
				);
				await sharedApplicationServer.startCloudflareTunnel(
					process.env.CLOUDFLARE_TOKEN,
				);
			}

			// Start temporary server to receive OAuth callback
			const authCode = await this.waitForCallback(clientId);

			// Exchange code for tokens
			console.log("Exchanging code for tokens...");
			const tokens = await this.exchangeCodeForTokens(
				authCode,
				clientId,
				clientSecret,
			);
			this.logSuccess("Got access token");

			// Fetch workspace info
			console.log("Fetching workspace info...");
			const workspace = await this.fetchWorkspaceInfo(tokens.accessToken);
			this.logSuccess(`Workspace: ${workspace.name} (${workspace.id})`);

			// Never save credentials from the wrong workspace into a tenant
			if (options.expectSlug && workspace.slug !== options.expectSlug) {
				throw new Error(
					`Authorized workspace "${workspace.slug}" does not match the expected slug "${options.expectSlug}"; nothing saved. Log in to the right Linear workspace and retry.`,
				);
			}
			if (tenant && tenant.linearWorkspaceId !== workspace.id) {
				throw new Error(
					`Authorized workspace ${workspace.id} is not tenant "${tenant.id}"'s workspace; nothing saved.`,
				);
			}

			// Save workspace credentials to config.json
			console.log("Saving tokens to config.json...");
			if (!config.linearWorkspaces) {
				(config as Record<string, unknown>).linearWorkspaces = {};
			}
			config.linearWorkspaces![workspace.id] = {
				linearToken: tokens.accessToken,
				...(tokens.refreshToken
					? { linearRefreshToken: tokens.refreshToken }
					: {}),
				linearWorkspaceName: workspace.name,
				linearWorkspaceSlug: workspace.slug,
			};
			writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf-8");

			this.logSuccess(`Saved credentials for workspace: ${workspace.name}`);
			if (!config.repositories || config.repositories.length === 0) {
				console.log(
					"   No repositories configured yet. Run 'kittu self-add-repo' to add one.",
				);
			}

			console.log();
			this.logSuccess(
				"Authentication complete! Restart kittu to use the new tokens.",
			);
			process.exit(0);
		} catch (error) {
			this.logError(`Authentication failed: ${(error as Error).message}`);
			process.exit(1);
		} finally {
			// One of the key guarantees of finally — it runs regardless of how the try block exits (return, throw, or normal completion).
			await this.cleanup();
		}
	}

	private async waitForCallback(clientId: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const baseUrl = process.env.KITTU_BASE_URL;
			if (!baseUrl) {
				reject(new Error("KITTU_BASE_URL environment variable is required"));
				return;
			}
			const redirectUri = `${baseUrl}/callback`;
			// https://linear.app/developers/oauth-2-0-authentication
			// https://linear.app/developers/oauth-actor-authorization
			const oauthUrl = `https://linear.app/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=write,app:assignable,app:mentionable&actor=app`;

			this.server = Fastify({ logger: false });

			this.server.get("/callback", async (request, reply) => {
				const query = request.query as { code?: string; error?: string };
				const code = query.code;
				const error = query.error;

				if (error) {
					reply
						.type("text/html; charset=utf-8")
						.code(400)
						.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Authorization failed</h2>
<p>${error}</p>
</body></html>`);
					reject(new Error(`OAuth error: ${error}`));
					return;
				}

				if (code) {
					reply
						.type("text/html; charset=utf-8")
						.code(200)
						.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Kittu authorized successfully</h2>
<p>You can close this window and return to the terminal.</p>
</body></html>`);
					resolve(code);
					return;
				}

				reply
					.type("text/html; charset=utf-8")
					.code(400)
					.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Missing authorization code</h2>
</body></html>`);
				reject(new Error("Missing authorization code"));
			});

			const isExternalHost =
				process.env.KITTU_HOST_EXTERNAL?.toLowerCase().trim() === "true";
			const listenHost = isExternalHost ? "0.0.0.0" : "localhost";

			this.server
				.listen({ port: this.callbackPort, host: listenHost })
				.then(() => {
					console.log(
						`Waiting for authorization on port ${this.callbackPort}...`,
					);
					console.log();
					console.log("Opening browser for Linear authorization...");
					console.log();
					console.log("If browser doesn't open, visit:");
					console.log(oauthUrl);
					console.log();

					open(oauthUrl).catch(() => {
						console.log("Could not open browser automatically.");
					});
				})
				.catch((err) => {
					reject(new Error(`Server error: ${err.message}`));
				});
		});
	}

	private async exchangeCodeForTokens(
		code: string,
		clientId: string,
		clientSecret: string,
	): Promise<{ accessToken: string; refreshToken?: string }> {
		const baseUrl = process.env.KITTU_BASE_URL;
		const redirectUri = `${baseUrl}/callback`;

		// https://linear.app/developers/oauth-2-0-authentication
		const response = await fetch("https://api.linear.app/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				client_secret: clientSecret,
				grant_type: "authorization_code",
			}).toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${errorText}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
		};

		if (!data.access_token?.startsWith("lin_oauth_")) {
			throw new Error("Invalid access token received");
		}

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
		};
	}

	private async fetchWorkspaceInfo(
		accessToken: string,
	): Promise<{ id: string; name: string; slug: string }> {
		const linearClient = new LinearClient({ accessToken });
		const viewer = await linearClient.viewer;
		const organization = await viewer.organization;

		if (!organization?.id) {
			throw new Error("Failed to get workspace info from Linear");
		}

		return {
			id: organization.id,
			name: organization.name || organization.id,
			slug: organization.urlKey,
		};
	}

	private async cleanup(): Promise<void> {
		if (this.server) {
			await this.server.close();
			this.server = null;
		}
	}
}

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GitHubAppTokenProviderConfig {
	appId: string;
	installationId: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

export interface ScopedTokenOptions {
	/** Repository NAMES (without owner) the token is limited to. */
	repositories: string[];
	/** Permissions the token is limited to, e.g. `{ pull_requests: "write" }`. */
	permissions: Record<string, "read" | "write">;
}

/** Thrown when a scoped token can not be minted; carries only the HTTP status. */
export class GitHubTokenMintError extends Error {
	constructor(readonly status: number) {
		super(`[GitHubAppTokenProvider] scoped token mint failed (HTTP ${status})`);
		this.name = "GitHubTokenMintError";
	}
}

/**
 * Mints and caches GitHub App installation tokens for self-hosted users.
 *
 * Uses the App's private key to sign a JWT, then exchanges it for a
 * short-lived installation access token via the GitHub API.
 * Tokens are cached and refreshed 5 minutes before expiry.
 */
export class GitHubAppTokenProvider {
	private config: GitHubAppTokenProviderConfig;
	private cachedToken: string | null = null;
	private expiresAt = 0;
	private privateKeyPromise: Promise<string> | null = null;
	/** Scoped tokens, keyed by repositories+permissions. Never shared with `cachedToken`. */
	private scopedTokens = new Map<
		string,
		{ token: string; expiresAt: number }
	>();

	constructor(config: GitHubAppTokenProviderConfig) {
		this.config = config;
	}

	/**
	 * Get a valid installation access token.
	 * Returns cached token if still valid, otherwise mints a new one.
	 */
	async getToken(): Promise<string> {
		// Refresh 5 minutes before expiry
		if (this.cachedToken && Date.now() < this.expiresAt - 5 * 60 * 1000) {
			return this.cachedToken;
		}

		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		const response = await fetch(
			`${apiBase}/app/installations/${this.config.installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to create installation token: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};

		this.cachedToken = data.token;
		this.expiresAt = new Date(data.expires_at).getTime();

		return this.cachedToken;
	}

	/**
	 * Mint (or return the cached) installation token limited to the given
	 * repositories and permissions. Separate from {@link getToken}: the full
	 * installation token cache is never read or written here. Refreshes 5
	 * minutes before expiry. On failure throws {@link GitHubTokenMintError}
	 * (status only; the response body is not exposed).
	 */
	async getScopedToken(options: ScopedTokenOptions): Promise<string> {
		const key = JSON.stringify([
			[...options.repositories].sort(),
			Object.entries(options.permissions).sort(),
		]);
		const hit = this.scopedTokens.get(key);
		if (hit && Date.now() < hit.expiresAt - 5 * 60 * 1000) {
			return hit.token;
		}

		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";
		const response = await fetch(
			`${apiBase}/app/installations/${this.config.installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					repositories: options.repositories,
					permissions: options.permissions,
				}),
			},
		);
		if (!response.ok) {
			throw new GitHubTokenMintError(response.status);
		}
		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};
		this.scopedTokens.set(key, {
			token: data.token,
			expiresAt: new Date(data.expires_at).getTime(),
		});
		return data.token;
	}

	private loadPrivateKey(): Promise<string> {
		if (!this.privateKeyPromise) {
			this.privateKeyPromise = readFile(this.config.privateKeyPath, "utf-8");
		}
		return this.privateKeyPromise;
	}
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses Node's native crypto — no external JWT library needed.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 10 * 60,
			iss: appId,
		}),
	).toString("base64url");

	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey, "base64url");

	return `${header}.${payload}.${signature}`;
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryConfig } from "kittu-core";
import { GitHubTokenStore } from "kittu-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * Tests for CYHOST-913: multi-org GitHub App installation token support.
 *
 * `resolveGitHubToken` must prefer an org-matched token from the local
 * token store (pushed by cyrus-hosted) over the forwarded installation
 * token, the self-minted App token, and the GITHUB_TOKEN PAT.
 *
 * The private method is exercised directly against a minimal `this` shape
 * (token store + logger + optional App token provider) to avoid the heavy
 * EdgeWorker constructor.
 */
describe("EdgeWorker.resolveGitHubToken precedence (CYHOST-913)", () => {
	let kittuHome: string;
	let store: GitHubTokenStore;
	let savedGitHubTokenEnv: string | undefined;
	let savedTokenFileEnv: string | undefined;

	const repository = {
		id: "repo-1",
		name: "Repo One",
		repositoryPath: "/tmp/repo-one",
		workspaceBaseDir: "/tmp/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		isActive: true,
		githubUrl: "https://github.com/myorg/repo-one",
	} as RepositoryConfig;

	const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };

	function resolve(
		event: { installationToken?: string },
		repo?: RepositoryConfig,
		appTokenProvider?: { getToken: () => Promise<string> },
	): Promise<string | undefined> {
		const fakeThis = {
			githubTokenStore: store,
			gitHubAppTokenProvider: appTokenProvider ?? null,
			logger,
		};
		return (
			EdgeWorker.prototype as unknown as {
				resolveGitHubToken: (
					event: unknown,
					repository?: RepositoryConfig,
				) => Promise<string | undefined>;
			}
		).resolveGitHubToken.call(fakeThis, event, repo);
	}

	beforeEach(() => {
		kittuHome = mkdtempSync(join(tmpdir(), "kittu-token-resolution-"));
		store = new GitHubTokenStore(kittuHome);
		savedGitHubTokenEnv = process.env.GITHUB_TOKEN;
		delete process.env.GITHUB_TOKEN;
		savedTokenFileEnv = process.env.GITHUB_TOKEN_FILE;
		delete process.env.GITHUB_TOKEN_FILE;
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (savedTokenFileEnv === undefined) {
			delete process.env.GITHUB_TOKEN_FILE;
		} else {
			process.env.GITHUB_TOKEN_FILE = savedTokenFileEnv;
		}
		rmSync(kittuHome, { recursive: true, force: true });
		if (savedGitHubTokenEnv === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = savedGitHubTokenEnv;
		}
	});

	it("prefers an org-matched store token over the forwarded installation token", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_from_store");
	});

	it("prefers an org-matched store token over the GITHUB_TOKEN env var", async () => {
		store.save([
			{
				installationId: "1",
				organization: "myorg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve({}, repository);
		expect(token).toBe("ghs_from_store");
	});

	it("falls back to the forwarded installation token when no store entry matches", async () => {
		store.save([
			{
				installationId: "1",
				organization: "unrelated-org",
				accountType: "Organization",
				token: "ghs_unrelated",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
			{
				installationId: "2",
				organization: "another-org",
				accountType: "Organization",
				token: "ghs_another",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_forwarded");
	});

	it("falls back to GITHUB_TOKEN when the store has no match and no token was forwarded", async () => {
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve({}, repository);
		expect(token).toBe("ghp_pat");
	});

	it("ignores expired store tokens", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_expired",
				expiresAt: new Date(Date.now() - 3600_000).toISOString(),
			},
		]);

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_forwarded");
	});

	it("skips the store tier when no repository is provided", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);

		const token = await resolve({ installationToken: "ghs_forwarded" });
		expect(token).toBe("ghs_forwarded");
	});

	it("uses the self-minted App token before GITHUB_TOKEN when no store entry matches", async () => {
		process.env.GITHUB_TOKEN = "ghp_pat";
		const provider = { getToken: vi.fn().mockResolvedValue("ghs_minted") };

		const token = await resolve({}, repository, provider);
		expect(token).toBe("ghs_minted");
		expect(provider.getToken).toHaveBeenCalled();
	});

	describe("GITHUB_TOKEN_FILE tier", () => {
		let tokenFile: string;

		beforeEach(() => {
			tokenFile = join(kittuHome, "github-token");
			process.env.GITHUB_TOKEN_FILE = tokenFile;
			process.env.GITHUB_TOKEN = "ghp_pat";
		});

		it("re-reads the file on every call", async () => {
			writeFileSync(tokenFile, "ghs_file_1");
			expect(await resolve({})).toBe("ghs_file_1");
			writeFileSync(tokenFile, "ghs_file_2");
			expect(await resolve({})).toBe("ghs_file_2");
		});

		it("trims surrounding whitespace", async () => {
			writeFileSync(tokenFile, "  ghs_file\n");
			expect(await resolve({})).toBe("ghs_file");
		});

		it("falls back to GITHUB_TOKEN when the file is missing", async () => {
			expect(await resolve({})).toBe("ghp_pat");
		});

		it("falls back to GITHUB_TOKEN when the file is empty", async () => {
			writeFileSync(tokenFile, " \n");
			expect(await resolve({})).toBe("ghp_pat");
		});

		it("behaves as before when GITHUB_TOKEN_FILE is unset", async () => {
			delete process.env.GITHUB_TOKEN_FILE;
			writeFileSync(tokenFile, "ghs_file");
			expect(await resolve({})).toBe("ghp_pat");
		});

		it("ranks below the forwarded and App tokens", async () => {
			writeFileSync(tokenFile, "ghs_file");
			expect(await resolve({ installationToken: "ghs_fwd" })).toBe("ghs_fwd");
			const provider = { getToken: vi.fn().mockResolvedValue("ghs_minted") };
			expect(await resolve({}, undefined, provider)).toBe("ghs_minted");
		});

		it("never logs the token or the file path", async () => {
			writeFileSync(tokenFile, "ghs_secret_value");
			await resolve({});
			rmSync(tokenFile);
			await resolve({});
			writeFileSync(tokenFile, "");
			await resolve({});
			const logged = JSON.stringify([
				logger.warn.mock.calls,
				logger.debug.mock.calls,
				logger.info.mock.calls,
			]);
			expect(logged).not.toContain("ghs_secret_value");
			expect(logged).not.toContain(tokenFile);
		});
	});
});

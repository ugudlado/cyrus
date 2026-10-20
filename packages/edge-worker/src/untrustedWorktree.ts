/** Env var that switches Cyrus into untrusted-worktree mode (default off). */
export const UNTRUSTED_WORKTREE_ENV = "CYRUS_UNTRUSTED_WORKTREE";

/**
 * Whether untrusted-worktree mode is enabled via `CYRUS_UNTRUSTED_WORKTREE=1`.
 *
 * In this mode nothing a session can write into its own worktree is trusted as
 * configuration: repo `cyrus-setup/teardown` scripts are not run, `<worktree>/.env`
 * and `<worktree>/.mcp.json` are not loaded, `settingSources` is empty, and the
 * worktree `.claude/settings.local.json` is not written. Read once at startup.
 */
export function isUntrustedWorktreeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env[UNTRUSTED_WORKTREE_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true";
}

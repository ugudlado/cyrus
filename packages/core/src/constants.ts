import { join } from "node:path";

/**
 * Shared constants used across Kittu packages
 */

/**
 * Default proxy URL for Kittu hosted services
 */
export const DEFAULT_PROXY_URL = "https://kittu-proxy.ceedar.workers.dev";

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default directory name for cloned repositories
 */
export const DEFAULT_REPOS_DIR = "repos";

/**
 * Resolves the repos directory, preferring KITTU_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(kittuHome: string): string {
	return (
		process.env.KITTU_REPOS_DIR?.trim() || join(kittuHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Resolves the worktrees directory, preferring KITTU_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(kittuHome: string): string {
	return (
		process.env.KITTU_WORKTREES_DIR?.trim() ||
		join(kittuHome, DEFAULT_WORKTREES_DIR)
	);
}

/**
 * Default base branch for new repositories
 */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Default config filename
 */
export const DEFAULT_CONFIG_FILENAME = "config.json";

import { existsSync } from "node:fs";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import type { SessionGit } from "../gitEnv.js";

/**
 * Tool names whose successful invocation may have produced a brand-new file
 * that the agent intends to ship. Marking that file with
 * `git add --intent-to-add` ensures the Stop-hook guardrail (which uses
 * `git status --untracked-files=no`) still flags the file as unshipped if
 * the agent forgets to commit it before ending the session.
 */
const FILE_WRITING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * Abstraction over the git/filesystem calls used by the hook so tests can
 * stub them without spawning real git processes.
 */
export interface IntentToAddGitClient {
	/** Returns true when `cwd` is inside a git working tree. */
	isGitRepo(cwd: string): boolean;
	/** Returns true when `path` exists on disk. */
	pathExists(path: string): boolean;
	/** Returns true when `path` matches a `.gitignore` rule relative to `cwd`. */
	isIgnored(cwd: string, path: string): boolean;
	/** Returns true when `path` is already tracked by git in `cwd`. */
	isTracked(cwd: string, path: string): boolean;
	/** Runs `git add --intent-to-add` for `path` in `cwd`. */
	intentToAdd(cwd: string, path: string): void;
}

/**
 * Production implementation backed by the local `git` binary and `fs`.
 * All operations are designed to fail silently — a missing/broken git
 * environment must not turn the hook into an error.
 */
export class DefaultIntentToAddGitClient implements IntentToAddGitClient {
	/**
	 * @param sessionGit Resolver of parent-pinned git invocations for the
	 *   session's worktrees. Without it every git check fails closed (the hook
	 *   is a no-op): git is never run with discovery from the workspace.
	 */
	constructor(private sessionGit?: SessionGit) {}

	private git(cwd: string, args: string[]): void {
		const inv = this.sessionGit?.invocationFor(cwd);
		if (!inv || !this.sessionGit) {
			throw new Error("no pinned git invocation");
		}
		this.sessionGit.gitEnv.run(inv, args);
	}

	isGitRepo(cwd: string): boolean {
		try {
			const inv = this.sessionGit?.invocationFor(cwd);
			if (!inv || !this.sessionGit) return false;
			const gitDir = this.sessionGit.gitEnv
				.run(inv, ["rev-parse", "--absolute-git-dir"])
				.trim();
			return gitDir === inv.env.GIT_DIR;
		} catch {
			return false;
		}
	}

	pathExists(path: string): boolean {
		try {
			return existsSync(path);
		} catch {
			return false;
		}
	}

	isIgnored(cwd: string, path: string): boolean {
		try {
			this.git(cwd, ["check-ignore", "-q", "--", path]);
			return true;
		} catch {
			return false;
		}
	}

	isTracked(cwd: string, path: string): boolean {
		try {
			this.git(cwd, ["ls-files", "--error-unmatch", "--", path]);
			return true;
		} catch {
			return false;
		}
	}

	intentToAdd(cwd: string, path: string): void {
		this.git(cwd, ["add", "--intent-to-add", "--", path]);
	}
}

/**
 * Extract the path argument from a Write/Edit/MultiEdit/NotebookEdit tool
 * input. Returns `undefined` when no string path is present — keeps the hook
 * a no-op for malformed or unexpected inputs.
 */
export function extractToolPath(toolInput: unknown): string | undefined {
	if (!toolInput || typeof toolInput !== "object") {
		return undefined;
	}
	const record = toolInput as Record<string, unknown>;
	for (const key of ["file_path", "notebook_path", "path"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * Apply `git add --intent-to-add` for `path` in `cwd` when, and only when,
 * all of the following hold:
 *   - `cwd` is a git repo
 *   - `path` exists on disk
 *   - `path` is not gitignored
 *   - `path` is not already tracked
 *
 * Any other state is a deliberate no-op. The function never throws.
 */
export function applyIntentToAdd(
	client: IntentToAddGitClient,
	cwd: string,
	path: string,
	log: ILogger,
): void {
	if (!client.isGitRepo(cwd)) {
		return;
	}
	if (!client.pathExists(path)) {
		return;
	}
	if (client.isIgnored(cwd, path)) {
		return;
	}
	if (client.isTracked(cwd, path)) {
		return;
	}
	try {
		client.intentToAdd(cwd, path);
		log.debug(`[IntentToAddHook] marked ${path} as intent-to-add`);
	} catch (err) {
		log.debug(
			`[IntentToAddHook] git add -N failed for ${path}: ${
				(err as Error).message
			}`,
		);
	}
}

/**
 * Build the PostToolUse hook that marks brand-new files created by
 * Write/Edit-style tools with `git add --intent-to-add`. Combined with the
 * Stop-hook guardrail's `--untracked-files=no`, this preserves the
 * "forgot-to-commit a new file" check while ignoring pre-existing untracked
 * files in the customer's worktree (which would otherwise wedge the agent).
 */
export function buildIntentToAddHook(
	log: ILogger,
	client: IntentToAddGitClient = new DefaultIntentToAddGitClient(),
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const matcher = `^(${FILE_WRITING_TOOLS.join("|")})$`;
	return {
		PostToolUse: [
			{
				matcher,
				hooks: [
					async (input) => {
						const post = input as PostToolUseHookInput;
						const filePath = extractToolPath(post.tool_input);
						if (!filePath) {
							return {};
						}
						try {
							applyIntentToAdd(client, post.cwd, filePath, log);
						} catch (err) {
							log.debug(`[IntentToAddHook] threw: ${(err as Error).message}`);
						}
						return {};
					},
				],
			},
		],
	};
}

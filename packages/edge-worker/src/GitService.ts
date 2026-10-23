import { execSync, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
	BaseBranchResolution,
	Issue,
	RepoSetupHookEventHandler,
	RepositoryConfig,
	Workspace,
} from "kittu-core";
import {
	createLogger,
	defaultKittuHome,
	getDefaultWorktreesDir,
	hookScriptCandidates,
	type ILogger,
} from "kittu-core";
import {
	GitEnv,
	GitEnvError,
	type GitInvocation,
	isPlainComponent,
} from "./gitEnv.js";
import { WorktreeIncludeService } from "./WorktreeIncludeService.js";

export interface CreateGitWorktreeOptions {
	globalSetupScript?: string;
	/** Called for repository setup hook lifecycle events. Global setup hooks do not emit events. */
	onRepoSetupHookEvent?: RepoSetupHookEventHandler;
	/**
	 * Override workspace base directory. Required for 0-repo workspaces.
	 * For 1+ repos, defaults to the first repository's workspaceBaseDir.
	 */
	workspaceBaseDir?: string;
	/**
	 * Per-repo base branch overrides from [repo=name#branch] syntax.
	 * Takes highest priority over graphite, parent, and default base branches.
	 */
	baseBranchOverrides?: Map<string, string>;
}

export interface GitServiceOptions {
	kittuHome?: string;
	/**
	 * Untrusted-worktree mode: never run the worktree's `kittu-setup.*` /
	 * `kittu-teardown.*` hook scripts (they are session-writable and run
	 * unsandboxed with the Kittu process env). The admin-configured global setup
	 * script is unaffected.
	 */
	untrustedWorktree?: boolean;
	/** Empty dir pinned as core.hooksPath for every parent git call. */
	gitHooksDir?: string;
	/** Credential helper injected into the parent's network git calls. */
	gitCredentialHelper?: string;
	/** Absolute path of the real gh (PR marker hook). */
	ghBinary?: string;
	/** Tests only: also allow the `file` protocol for local fixture remotes. */
	gitAllowFileProtocol?: boolean;
	/** Minimum free bytes required to clone (default 2 GB); tests lower it. */
	cloneMinFreeBytes?: number;
	/** Tests only: replace the git env (unit tests that stub the git process). */
	gitEnv?: GitEnv;
}

export interface DeleteWorktreeOptions {
	/**
	 * Repositories involved with this issue's workspace. When provided, each
	 * repo's `kittu-teardown.sh` (if present) is invoked before worktree removal,
	 * with `cwd` set to that repo's worktree subdirectory.
	 *
	 * In the single-repo layout, the worktree subdirectory is the workspace root.
	 * In multi-repo layouts, it is `<workspace>/<repository.name>/`.
	 */
	repositories?: RepositoryConfig[];
}

/** Timeout for repo setup scripts (kittu-setup.*). */
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for repo teardown scripts (kittu-teardown.*). */
const TEARDOWN_TIMEOUT_MS = 2 * 60 * 1000;

const HOOK_OUTPUT_TAIL_MAX_BYTES = 64 * 1024;
const HOOK_OUTPUT_TAIL_MAX_CHARS = 8_000;
const HOOK_OUTPUT_TAIL_MAX_LINES = 40;

type HookKind = "setup" | "teardown";

interface HookScriptOptions {
	scriptPath: string;
	hook: HookKind;
	/** Origin of the script for user-facing log messages. */
	originLabel: string;
	/** Working directory for the spawned process. */
	cwd: string;
	/** Environment variables to merge with `process.env`. */
	env: Record<string, string>;
	/** Timeout in milliseconds for the spawned process. */
	timeoutMs: number;
	repositoryName?: string;
	issueIdentifier?: string;
	onRepoSetupHookEvent?: RepoSetupHookEventHandler;
}

interface NodeExecError {
	signal?: string;
	message?: string;
	code?: number | string;
}

function isNodeExecError(value: unknown): value is NodeExecError {
	return typeof value === "object" && value !== null;
}

/**
 * Loggable summary of a failed git call. The raw error message of
 * execFileSync contains the full argv (which holds the remote URL), so only
 * the exit status and a trimmed stderr are logged.
 */
function describeGitError(e: unknown): string {
	if (e instanceof GitEnvError) return e.message;
	const x = e as {
		status?: number | null;
		stderr?: Buffer | string;
		message?: string;
	};
	if (x && (x.status !== undefined || x.stderr !== undefined)) {
		const stderr = (x.stderr?.toString() ?? "").trim().slice(0, 300);
		return `exit ${x.status ?? "?"}${stderr ? `: ${stderr}` : ""}`;
	}
	const message = x?.message ?? "git command failed";
	return message.startsWith("Command failed") ? "git command failed" : message;
}

/** Short, secret-free reason for a failed clone (shown to users). */
function cloneFailureReason(error: unknown): string {
	const message = (error as Error)?.message ?? "";
	if (message.startsWith("Not enough free disk space")) {
		return "not enough free disk space";
	}
	if (message === "Not a git repository") return "not a git repository";
	return "git clone failed";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactHookOutput(
	output: string,
	opts: { cwd: string; env: Record<string, string> },
): string {
	let redacted = output;
	const pathValues = [opts.cwd, homedir(), process.cwd()]
		.flatMap((pathValue) =>
			pathValue.startsWith("/var/")
				? [`/private${pathValue}`, pathValue]
				: [pathValue],
		)
		.filter(Boolean);
	for (const pathValue of pathValues) {
		const isWorkspacePath =
			pathValue === opts.cwd || pathValue === `/private${opts.cwd}`;
		redacted = redacted.replace(
			new RegExp(escapeRegExp(pathValue), "g"),
			isWorkspacePath ? "[workspace]" : "[path]",
		);
	}
	redacted = redacted.replace(/\/private\[workspace\]/g, "[workspace]");

	redacted = redacted.replace(
		/(?:\/Users|\/home|\/var\/folders|\/private\/tmp|\/tmp)\/[^\s'"`<>)]*/g,
		"[path]",
	);

	redacted = redacted.replace(
		/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN|SESSION|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
		"$1=[REDACTED]",
	);

	const sensitiveEnvPattern =
		/(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN|SESSION|COOKIE)/i;
	const sensitiveValues = new Set<string>();
	for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) {
		if (!sensitiveEnvPattern.test(key)) continue;
		if (!value || value.length < 4) continue;
		sensitiveValues.add(value);
	}
	for (const [key, value] of Object.entries(opts.env)) {
		if (key === "LINEAR_ISSUE_IDENTIFIER") continue;
		if (!value || value.length < 4) continue;
		sensitiveValues.add(value);
	}

	for (const value of sensitiveValues) {
		redacted = redacted.replace(
			new RegExp(escapeRegExp(value), "g"),
			"[REDACTED]",
		);
	}

	redacted = redacted
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED]");

	return redacted;
}

function truncateHookOutputTail(output: string): {
	text: string;
	truncated: boolean;
} {
	const lines = output.split(/\r?\n/);
	let truncated = false;
	let selectedLines = lines;
	if (lines.length > HOOK_OUTPUT_TAIL_MAX_LINES) {
		truncated = true;
		selectedLines = lines.slice(-HOOK_OUTPUT_TAIL_MAX_LINES);
	}

	let tail = selectedLines.join("\n");
	if (tail.length > HOOK_OUTPUT_TAIL_MAX_CHARS) {
		truncated = true;
		tail = tail.slice(-HOOK_OUTPUT_TAIL_MAX_CHARS);
	}

	return { text: tail.trim(), truncated };
}

class HookOutputCollector {
	private chunks: string[] = [];
	private bytes = 0;

	append(chunk: Buffer | string): void {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
		this.chunks.push(text);
		this.bytes += Buffer.byteLength(text, "utf8");

		while (this.bytes > HOOK_OUTPUT_TAIL_MAX_BYTES && this.chunks.length > 1) {
			const removed = this.chunks.shift() ?? "";
			this.bytes -= Buffer.byteLength(removed, "utf8");
		}

		if (this.bytes > HOOK_OUTPUT_TAIL_MAX_BYTES && this.chunks.length === 1) {
			const current = this.chunks[0] ?? "";
			const sliced = current.slice(-HOOK_OUTPUT_TAIL_MAX_BYTES);
			this.chunks[0] = sliced;
			this.bytes = Buffer.byteLength(sliced, "utf8");
		}
	}

	tail(opts: { cwd: string; env: Record<string, string> }): {
		text: string;
		truncated: boolean;
	} {
		return truncateHookOutputTail(redactHookOutput(this.chunks.join(""), opts));
	}
}

/**
 * Service responsible for Git worktree operations
 */
export class GitService {
	private logger: ILogger;
	private worktreeIncludeService: WorktreeIncludeService;
	private kittuHome: string;
	private untrustedWorktree: boolean;
	/** Parent-owned git env: location + config pins for every git call. */
	readonly gitEnv: GitEnv;
	private cloneMinFreeBytes: number;

	constructor(options?: GitServiceOptions, logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "GitService" });
		this.worktreeIncludeService = new WorktreeIncludeService(this.logger);
		this.kittuHome = options?.kittuHome ?? defaultKittuHome();
		this.untrustedWorktree = options?.untrustedWorktree ?? false;
		this.cloneMinFreeBytes = options?.cloneMinFreeBytes ?? 2 * 1024 ** 3;
		this.gitEnv =
			options?.gitEnv ??
			new GitEnv({
				kittuHome: this.kittuHome,
				hooksDir: options?.gitHooksDir,
				credentialHelper: options?.gitCredentialHelper,
				ghBinary: options?.ghBinary,
				allowFileProtocol: options?.gitAllowFileProtocol,
				logger: this.logger,
			});
	}

	/** Pinned repo-scope invocation; throws GitEnvError when unusable. */
	private repoInv(repoPath: string): GitInvocation {
		return this.gitEnv.repoScope(repoPath);
	}

	/**
	 * Check if a branch exists locally or remotely
	 */
	async branchExists(branchName: string, repoPath: string): Promise<boolean> {
		try {
			const inv = this.repoInv(repoPath);
			try {
				// Check if branch exists locally
				this.gitEnv.run(inv, ["rev-parse", "--verify", branchName]);
				return true;
			} catch {
				// Branch doesn't exist locally, check remote
				const url = this.remoteUrl(inv);
				const remoteOutput = this.gitEnv.run(inv, [
					"ls-remote",
					"--heads",
					"--",
					url,
					branchName,
				]);
				// Check if output is non-empty (branch actually exists on remote)
				return remoteOutput.trim().length > 0;
			}
		} catch {
			return false;
		}
	}

	/**
	 * The repository's remote URL, with the insteadOf post-check. Throws when
	 * there is no remote, the URL looks like an option, or it is rewritten.
	 */
	private remoteUrl(inv: GitInvocation): string {
		const url = this.gitEnv.trustedRemoteUrl(inv);
		if (url.startsWith("-")) {
			throw new GitEnvError("remote URL looks like an option");
		}
		return url;
	}

	/**
	 * Sanitize branch name by removing characters invalid in git refs.
	 * Git branch names cannot contain: space, ~, ^, :, ?, *, [, \, backtick,
	 * consecutive dots (..), ASCII control chars, or start/end with dot or slash.
	 * See `git check-ref-format` for the full specification.
	 */
	public sanitizeBranchName(name: string): string {
		if (!name) return name;
		return name
			.replace(/[`~^:?*[\]\\@{}\s]/g, "-") // replace invalid chars with dash
			.replace(/\.{2,}/g, ".") // collapse consecutive dots
			.replace(/\/{2,}/g, "/") // collapse consecutive slashes
			.replace(/\.lock(\/|$)/g, "$1") // remove .lock component
			.replace(/^[.\-/]+/, "") // strip leading dots, dashes, slashes
			.replace(/[.\-/]+$/, "") // strip trailing dots, dashes, slashes
			.replace(/-{2,}/g, "-"); // collapse consecutive dashes
	}

	/**
	 * Determine the base branch for an issue with full resolution info.
	 *
	 * Priority order:
	 * 0. Explicit override from [repo=name#branch] syntax
	 * 1. Graphite blocked-by relationship
	 * 2. Parent issue branch
	 * 3. Repository default base branch
	 *
	 * @param baseBranchOverride Optional override from [repo=name#branch] syntax (highest priority)
	 */
	async determineBaseBranch(
		issue: Issue,
		repository: RepositoryConfig,
		baseBranchOverride?: string,
	): Promise<BaseBranchResolution> {
		// Priority 0: Explicit override from [repo=name#branch] syntax
		if (baseBranchOverride) {
			this.logger.info(
				`Using commit-ish override '${baseBranchOverride}' as base branch for ${issue.identifier} in repo ${repository.name}`,
			);
			return {
				branch: baseBranchOverride,
				source: "commit-ish",
				detail: `[repo=...#${baseBranchOverride}]`,
			};
		}

		// Priority 1: Check graphite blocked-by relationship
		try {
			const isGraphiteIssue = await this.hasGraphiteLabel(issue, repository);

			if (isGraphiteIssue) {
				const blockingIssues = await this.fetchBlockingIssues(issue);

				if (blockingIssues.length > 0) {
					const blockingIssue = blockingIssues[0]!;
					this.logger.info(
						`Issue ${issue.identifier} has graphite label and is blocked by ${blockingIssue.identifier}`,
					);

					const blockingRawBranchName =
						blockingIssue.branchName ||
						`${blockingIssue.identifier}-${(blockingIssue.title ?? "")
							.toLowerCase()
							.replace(/\s+/g, "-")
							.substring(0, 30)}`;
					const blockingBranchName = this.sanitizeBranchName(
						blockingRawBranchName,
					);

					const blockingBranchExists = await this.branchExists(
						blockingBranchName,
						repository.repositoryPath,
					);

					if (blockingBranchExists) {
						this.logger.info(
							`Using blocking issue branch '${blockingBranchName}' as base for Graphite-stacked issue ${issue.identifier}`,
						);
						return {
							branch: blockingBranchName,
							source: "graphite-blocked-by",
							detail: `blocked by ${blockingIssue.identifier}`,
						};
					}
					this.logger.info(
						`Blocking issue branch '${blockingBranchName}' not found, falling back to parent/default`,
					);
				}
			}
		} catch (_error) {
			this.logger.info(
				`Failed to check graphite label for ${issue.identifier}, falling back to parent/default`,
			);
		}

		// Priority 2: Check parent issue
		try {
			const parent = await (issue as any).parent;
			if (parent) {
				this.logger.info(
					`Issue ${issue.identifier} has parent: ${parent.identifier}`,
				);

				const parentRawBranchName =
					parent.branchName ||
					`${parent.identifier}-${parent.title
						?.toLowerCase()
						.replace(/\s+/g, "-")
						.substring(0, 30)}`;
				const parentBranchName = this.sanitizeBranchName(parentRawBranchName);

				const parentBranchExists = await this.branchExists(
					parentBranchName,
					repository.repositoryPath,
				);

				if (parentBranchExists) {
					this.logger.info(
						`Using parent issue branch '${parentBranchName}' as base for sub-issue ${issue.identifier}`,
					);
					return {
						branch: parentBranchName,
						source: "parent-issue",
						detail: `parent ${parent.identifier}`,
					};
				}
				this.logger.info(
					`Parent branch '${parentBranchName}' not found, using default base branch '${repository.baseBranch}'`,
				);
			}
		} catch (_error) {
			this.logger.info(
				`No parent issue found for ${issue.identifier}, using default base branch '${repository.baseBranch}'`,
			);
		}

		// Priority 3: Repository default
		return {
			branch: repository.baseBranch,
			source: "default",
		};
	}

	/**
	 * Check if an issue has the graphite label
	 */
	async hasGraphiteLabel(
		issue: Issue,
		repository: RepositoryConfig,
	): Promise<boolean> {
		const graphiteConfig = repository.labelPrompts?.graphite;
		const graphiteLabels = Array.isArray(graphiteConfig)
			? graphiteConfig
			: (graphiteConfig?.labels ?? ["graphite"]);

		const issueLabels = await this.fetchIssueLabels(issue);
		return graphiteLabels.some((label: string) => issueLabels.includes(label));
	}

	/**
	 * Fetch issues that block this issue (i.e., issues this one is "blocked by").
	 * Uses the inverseRelations field with type "blocks".
	 */
	async fetchBlockingIssues(issue: Issue): Promise<Issue[]> {
		try {
			const inverseRelations = await issue.inverseRelations();
			if (!inverseRelations?.nodes) {
				return [];
			}

			const blockingIssues: Issue[] = [];

			for (const relation of inverseRelations.nodes) {
				if (relation.type === "blocks") {
					const blockingIssue = await relation.issue;
					if (blockingIssue) {
						blockingIssues.push(blockingIssue);
					}
				}
			}

			this.logger.debug(
				`Issue ${issue.identifier} is blocked by ${blockingIssues.length} issue(s): ${blockingIssues.map((i) => i.identifier).join(", ") || "none"}`,
			);

			return blockingIssues;
		} catch (error) {
			this.logger.error(
				`Failed to fetch blocking issues for ${issue.identifier}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Fetch label names for an issue
	 */
	async fetchIssueLabels(issue: Issue): Promise<string[]> {
		try {
			const labels = await issue.labels();
			return labels.nodes.map((label) => label.name);
		} catch (error) {
			this.logger.error(`Failed to fetch labels for issue ${issue.id}:`, error);
			return [];
		}
	}

	/**
	 * Create a workspace for an issue with 0, 1, or N repositories.
	 *
	 * - **0 repos**: Creates a plain folder at `workspaceBaseDir/ISSUE-ID/` (no git worktree)
	 * - **1 repo**: Git worktree directly at `repo.workspaceBaseDir/ISSUE-ID/` (preserves current behavior)
	 * - **N repos**: Parent folder at `workspaceBaseDir/ISSUE-ID/` with per-repo worktree subdirs
	 */
	async createGitWorktree(
		issue: Issue,
		repositories: RepositoryConfig[],
		options?: CreateGitWorktreeOptions,
	): Promise<Workspace> {
		const {
			globalSetupScript,
			onRepoSetupHookEvent,
			workspaceBaseDir: overrideBaseDir,
			baseBranchOverrides,
		} = options ?? {};

		if (repositories.length === 0) {
			// 0 repos: create a plain folder (no git worktree)
			const baseDir = overrideBaseDir;
			if (!baseDir) {
				throw new Error(
					"workspaceBaseDir is required in options when no repositories are provided",
				);
			}
			const workspacePath = join(baseDir, issue.identifier);
			mkdirSync(workspacePath, { recursive: true });
			this.logger.info(
				`Created plain workspace (no repos) at ${workspacePath}`,
			);

			// Run global setup script if configured
			if (globalSetupScript) {
				await this.runSetupScript(
					globalSetupScript,
					"global",
					workspacePath,
					issue,
				);
			}

			return {
				path: workspacePath,
				isGitWorktree: false,
			};
		}

		if (repositories.length === 1) {
			// 1 repo: preserve exact current behavior
			const repoId = repositories[0]!.id;
			const overrideValue = baseBranchOverrides?.get(repoId);
			this.logger.info(
				`createGitWorktree: baseBranchOverrides=${baseBranchOverrides ? `Map(size=${baseBranchOverrides.size})` : "undefined"}, repoId=${repoId}, overrideValue=${overrideValue ?? "undefined"}`,
			);
			return this.createSingleRepoClone(
				issue,
				repositories[0]!,
				globalSetupScript,
				undefined,
				overrideValue,
				onRepoSetupHookEvent,
			);
		}

		// N repos: parent folder with per-repo subdirectories
		const baseDir = overrideBaseDir ?? repositories[0]!.workspaceBaseDir;
		const parentPath = join(baseDir, issue.identifier);
		mkdirSync(parentPath, { recursive: true });
		this.logger.info(
			`Creating multi-repo workspace at ${parentPath} for ${repositories.length} repositories`,
		);

		// Run global setup script once in the parent directory
		if (globalSetupScript) {
			await this.runSetupScript(globalSetupScript, "global", parentPath, issue);
		}

		const repoPaths: Record<string, string> = {};
		const resolvedBaseBranches: Record<string, BaseBranchResolution> = {};
		const gitDirNames: Record<string, string> = {};
		const branchNames: Record<string, string> = {};
		const cloneFailed: string[] = [];
		const cloneFailures: Record<string, string> = {};

		for (const repository of repositories) {
			const repoSubPath = join(parentPath, repository.name);
			this.logger.info(
				`Creating worktree for repo '${repository.name}' at ${repoSubPath}`,
			);

			try {
				const repoWorkspace = await this.createSingleRepoClone(
					issue,
					repository,
					undefined, // global setup already ran
					repoSubPath, // override workspace path for N-repo layout
					baseBranchOverrides?.get(repository.id),
					onRepoSetupHookEvent,
				);
				repoPaths[repository.id] = repoWorkspace.path;
				if (repoWorkspace.resolvedBaseBranches) {
					Object.assign(
						resolvedBaseBranches,
						repoWorkspace.resolvedBaseBranches,
					);
				}
				if (repoWorkspace.cloneFailed) {
					cloneFailed.push(...repoWorkspace.cloneFailed);
					Object.assign(cloneFailures, repoWorkspace.cloneFailures ?? {});
				}
				if (repoWorkspace.branchNames) {
					Object.assign(branchNames, repoWorkspace.branchNames);
				}
				if (repoWorkspace.gitDirNames) {
					Object.assign(gitDirNames, repoWorkspace.gitDirNames);
				}
			} catch (error) {
				this.logger.error(
					`Failed to create worktree for repo '${repository.name}': ${(error as Error).message}`,
				);
				// Create fallback directory for this repo
				mkdirSync(repoSubPath, { recursive: true });
				repoPaths[repository.id] = repoSubPath;
				cloneFailed.push(repository.id);
				cloneFailures[repository.id] = "git clone failed";
			}
		}

		return {
			path: parentPath,
			isGitWorktree: true,
			repoPaths,
			resolvedBaseBranches,
			...(Object.keys(gitDirNames).length > 0 ? { gitDirNames } : {}),
			...(Object.keys(branchNames).length > 0 ? { branchNames } : {}),
			...(cloneFailed.length > 0 ? { cloneFailed, cloneFailures } : {}),
		};
	}

	/**
	 * Create (or reuse) the session's standalone clone of one repository.
	 *
	 * A clone replaces the old linked worktree: the session gets its own full
	 * `.git` (objects copied with --no-hardlinks), so nothing under the shared
	 * `~/repos/<name>` is reachable from the sandbox. Every parent git call
	 * runs under the pins of {@link GitEnv}; the clone's `.git` is shape-checked
	 * before any call and its config is re-stamped by the parent.
	 *
	 * @param workspacePathOverride - Override the workspace path (used for N-repo subdirectories)
	 */
	private async createSingleRepoClone(
		issue: Issue,
		repository: RepositoryConfig,
		globalSetupScript?: string,
		workspacePathOverride?: string,
		baseBranchOverride?: string,
		onRepoSetupHookEvent?: RepoSetupHookEventHandler,
	): Promise<Workspace> {
		this.logger.info(
			`createSingleRepoClone for ${repository.name} (id=${repository.id}): baseBranchOverride=${baseBranchOverride ?? "undefined"}`,
		);
		// Build a fallback resolution for error paths where determineBaseBranch hasn't run
		const fallbackResolution: BaseBranchResolution = baseBranchOverride
			? {
					branch: baseBranchOverride,
					source: "commit-ish",
					detail: `[repo=...#${baseBranchOverride}]`,
				}
			: { branch: repository.baseBranch, source: "default" };

		// Use Linear's preferred branch name, or generate one if not available.
		// This is the branch the PARENT creates; it is recorded on the workspace
		// so later parent-side calls (gh pr view) use it, not the raw Linear name.
		const rawBranchName =
			issue.branchName ||
			`${issue.identifier}-${issue.title
				?.toLowerCase()
				.replace(/\s+/g, "-")
				.substring(0, 30)}`;
		const branchName = this.sanitizeBranchName(rawBranchName);
		const branchNames = { branchNames: { [repository.id]: branchName } };
		const workspacePath =
			workspacePathOverride ??
			join(repository.workspaceBaseDir, issue.identifier);
		let createdHere = false;

		try {
			// Verify this is a git repository
			let repoInv: GitInvocation;
			try {
				repoInv = this.repoInv(repository.repositoryPath);
				this.gitEnv.run(repoInv, ["rev-parse", "--git-dir"]);
			} catch (_e) {
				this.logger.error(
					`${repository.repositoryPath} is not a git repository`,
				);
				throw new Error("Not a git repository");
			}

			mkdirSync(dirname(workspacePath), { recursive: true });

			// Determine base branch early (commit-ish > graphite > parent > default)
			const resolution = await this.determineBaseBranch(
				issue,
				repository,
				baseBranchOverride,
			);
			const baseBranch = resolution.branch;

			// The trusted origin URL: read from the parent's repo config with the
			// insteadOf post-check. Without it the clone is offline.
			let remoteUrl: string | undefined;
			try {
				remoteUrl = this.remoteUrl(repoInv);
			} catch (e) {
				this.logger.warn(
					"No trusted remote URL, proceeding offline:",
					describeGitError(e),
				);
			}

			// Reuse an existing clone only if it passes the shape check; anything
			// else (a session-made pointer, a legacy worktree, stray files) is
			// moved aside untouched and replaced.
			const existing = this.classifyWorkspaceDir(workspacePath);
			if (existing === "clone") {
				try {
					this.gitEnv.assertCloneShape(workspacePath);
					return await this.reuseClone(
						repoInv,
						repository,
						workspacePath,
						branchName,
						remoteUrl,
						{ resolution, branchNames },
					);
				} catch (e) {
					if (!(e instanceof GitEnvError)) throw e;
					this.logger.warn(
						`Existing clone for ${repository.name} failed the shape check (${e.message}); moving it aside`,
					);
					this.quarantine(workspacePath, "quarantine");
				}
			} else if (existing === "legacy-worktree") {
				this.logger.warn(
					`Existing git worktree for ${repository.name} replaced by a clone; the old directory is kept aside`,
				);
				this.quarantine(workspacePath, "worktree-old");
			} else if (existing === "other") {
				const aside = this.quarantine(workspacePath, "quarantine");
				this.logger.info(
					`Workspace path for ${repository.name} held something that is not a clone; moved aside to ${basename(aside)}`,
				);
			}

			// GitHub -> source repository, in repo scope only (trusted config,
			// explicit URL and refspec, credential helper). The clone is then
			// updated from this LOCAL source; no network git ever runs against a
			// config the session can write.
			const hasRemote = this.refreshSource(repoInv, remoteUrl);

			this.assertDiskSpace(repository.repositoryPath, dirname(workspacePath));

			// Local clone of the parent-owned source. --no-hardlinks: shared
			// inodes would let a session corrupt the source's objects. The file
			// protocol is allowed for THIS call only (the pins set
			// protocol.allow=never for everything else).
			createdHere = true;
			this.gitEnv.run(this.gitEnv.plainScope(dirname(workspacePath)), [
				"-c",
				"protocol.file.allow=always",
				"clone",
				"--no-hardlinks",
				"--no-checkout",
				// Shallow clones need the file:// transport (a plain path is a
				// local copy that ignores --depth).
				...(repository.cloneDepth
					? ["--depth", String(repository.cloneDepth)]
					: []),
				"--",
				repository.cloneDepth
					? `file://${realpathSync.native(repository.repositoryPath)}`
					: realpathSync.native(repository.repositoryPath),
				workspacePath,
			]);
			this.gitEnv.restampCloneConfig(workspacePath, { remoteUrl });

			const inv = (): GitInvocation => this.gitEnv.cloneScope(workspacePath);
			const git = (args: string[]): string => this.gitEnv.run(inv(), args);

			this.updateCloneFromSource(
				repoInv,
				repository,
				workspacePath,
				Boolean(repository.cloneDepth),
			);

			// Start point. The clone carries the source's local branches as
			// origin/*; the fetch above refreshes them from the real remote.
			const refExists = (ref: string): boolean => {
				try {
					git(["rev-parse", "--verify", "--quiet", ref]);
					return true;
				} catch {
					return false;
				}
			};
			let startPoint: string;
			if (refExists(`refs/remotes/origin/${branchName}`)) {
				this.logger.info(
					`Creating branch ${branchName} from existing origin/${branchName}`,
				);
				startPoint = `origin/${branchName}`;
			} else if (refExists(`refs/remotes/origin/${baseBranch}`)) {
				this.logger.info(
					`Creating branch ${branchName} from origin/${baseBranch}${hasRemote ? "" : " (offline)"}`,
				);
				startPoint = `origin/${baseBranch}`;
			} else {
				this.logger.info(
					`Base branch '${baseBranch}' not found, falling back to ${repository.baseBranch}`,
				);
				startPoint = `origin/${repository.baseBranch}`;
			}
			// -B: the clone already has a local branch named like the source's HEAD
			// branch; (re)point it at the start point instead of failing.
			git(["checkout", "--no-track", "-B", branchName, startPoint]);
			// branch.<name>.remote/merge point at the branch's own name on the
			// remote (so @{u}..HEAD is accurate); the re-stamp writes them.
			this.gitEnv.restampCloneConfig(workspacePath, {
				remoteUrl,
				branch: branchName,
			});

			// Copy files specified in .worktreeinclude that are also in .gitignore
			// This runs before setup scripts so they can access these files
			await this.worktreeIncludeService.copyIgnoredFiles(
				repository.repositoryPath,
				workspacePath,
			);

			// First, run the global setup script if configured
			if (globalSetupScript) {
				await this.runSetupScript(
					globalSetupScript,
					"global",
					workspacePath,
					issue,
				);
			}

			// Then, check for repository setup scripts (cross-platform)
			await this.runRepoSetupScript(
				workspacePath,
				issue,
				repository.name,
				onRepoSetupHookEvent,
			);

			return {
				path: workspacePath,
				isGitWorktree: true,
				resolvedBaseBranches: { [repository.id]: resolution },
				...branchNames,
			};
		} catch (error) {
			this.logger.error("Failed to create git clone:", describeGitError(error));
			// A half-made clone from THIS call holds nothing of the session's.
			if (createdHere) {
				rmSync(workspacePath, { recursive: true, force: true });
			}
			// Fall back to a plain directory; the repo is flagged so it gets no
			// git shape and no token dir.
			mkdirSync(workspacePath, { recursive: true });
			return {
				path: workspacePath,
				isGitWorktree: false,
				resolvedBaseBranches: { [repository.id]: fallbackResolution },
				...branchNames,
				cloneFailed: [repository.id],
				cloneFailures: { [repository.id]: cloneFailureReason(error) },
			};
		}
	}

	/** What is at `path`: nothing, an empty dir, a clone, a legacy worktree, or other. */
	private classifyWorkspaceDir(
		path: string,
	): "none" | "empty" | "clone" | "legacy-worktree" | "other" {
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(path);
		} catch {
			return "none";
		}
		if (!st.isDirectory()) return "other";
		const entries = readdirSync(path);
		if (entries.length === 0) return "empty";
		if (!entries.includes(".git")) return "other";
		try {
			const g = lstatSync(join(path, ".git"));
			if (g.isFile()) return "legacy-worktree";
			return "clone"; // directory or symlink: the shape check decides
		} catch {
			return "other";
		}
	}

	/** Move a directory aside, untouched, to `<path>.<kind>-<timestamp>`. */
	private quarantine(
		path: string,
		kind: "quarantine" | "worktree-old",
	): string {
		const target = `${path}.${kind}-${Date.now()}`;
		renameSync(path, target);
		return target;
	}

	/**
	 * GitHub -> the parent-owned source repository (`~/repos/<name>`): explicit
	 * trusted URL and refspec under the repo pins (credential helper included).
	 * Returns false (offline) when it fails or there is no trusted URL.
	 */
	private refreshSource(repoInv: GitInvocation, remoteUrl?: string): boolean {
		if (!remoteUrl) return false;
		try {
			this.gitEnv.run(repoInv, [
				"fetch",
				"--prune",
				"--",
				remoteUrl,
				"+refs/heads/*:refs/remotes/origin/*",
			]);
			return true;
		} catch (e) {
			this.logger.warn(
				"Warning: git fetch failed, proceeding with local refs:",
				describeGitError(e),
			);
			return false;
		}
	}

	/**
	 * Update the clone's remote-tracking refs from the LOCAL source repository
	 * (never from the network, no credential helper): the file protocol is
	 * allowed for this call only. `shallow` keeps `--depth` (needs file://);
	 * a source with no remote-tracking refs is skipped so --prune can not wipe
	 * the clone's copies of the source's local branches.
	 */
	private updateCloneFromSource(
		repoInv: GitInvocation,
		repository: RepositoryConfig,
		workspacePath: string,
		shallow: boolean,
	): boolean {
		try {
			const hasRemoteRefs =
				this.gitEnv
					.run(repoInv, [
						"for-each-ref",
						"--count=1",
						"--format=%(refname)",
						"refs/remotes/origin",
					])
					.trim() !== "";
			if (!hasRemoteRefs) return false;
			const source = realpathSync.native(repository.repositoryPath);
			this.gitEnv.run(this.gitEnv.cloneScope(workspacePath), [
				"-c",
				"protocol.file.allow=always",
				"fetch",
				"--prune",
				...(shallow && repository.cloneDepth
					? ["--depth", String(repository.cloneDepth)]
					: []),
				"--",
				shallow ? `file://${source}` : source,
				"+refs/remotes/origin/*:refs/remotes/origin/*",
			]);
			return true;
		} catch (e) {
			this.logger.warn(
				"Warning: could not update the clone from the source repository:",
				describeGitError(e),
			);
			return false;
		}
	}

	/**
	 * Reuse a clone that passed the shape check: re-stamp its config, fetch with
	 * the explicit URL, and fast-forward the session branch only when the tree
	 * is clean and the branch is strictly behind its remote counterpart.
	 */
	private async reuseClone(
		repoInv: GitInvocation,
		repository: RepositoryConfig,
		workspacePath: string,
		branchName: string,
		remoteUrl: string | undefined,
		extra: {
			resolution: BaseBranchResolution;
			branchNames: { branchNames: Record<string, string> };
		},
	): Promise<Workspace> {
		this.logger.info(
			`Clone already exists at ${workspacePath}, using existing`,
		);
		this.gitEnv.restampCloneConfig(workspacePath, {
			remoteUrl,
			branch: branchName,
		});
		const hasRemote = this.refreshSource(repoInv, remoteUrl);
		// --depth only for a clone that is already shallow: never turn a full
		// clone shallow (or deepen a shallow one) by accident.
		const shallow =
			Boolean(repository.cloneDepth) &&
			existsSync(join(workspacePath, ".git", "shallow"));
		const updated = this.updateCloneFromSource(
			repoInv,
			repository,
			workspacePath,
			shallow,
		);
		if (hasRemote && updated) {
			try {
				const run = (args: string[]) =>
					this.gitEnv.run(this.gitEnv.cloneScope(workspacePath), args);
				const current = run(["branch", "--show-current"]).trim();
				const clean =
					run(["status", "--porcelain", "--untracked-files=no"]).trim() === "";
				if (current === branchName && clean) {
					let behind = false;
					try {
						run([
							"merge-base",
							"--is-ancestor",
							"HEAD",
							`origin/${branchName}`,
						]);
						behind =
							run(["rev-parse", "HEAD"]).trim() !==
							run(["rev-parse", `origin/${branchName}`]).trim();
					} catch {
						behind = false;
					}
					if (behind) {
						run(["merge", "--ff-only", `origin/${branchName}`]);
						this.logger.info(
							`Fast-forwarded ${branchName} to origin/${branchName}`,
						);
					}
				} else if (current === branchName) {
					this.logger.info(
						`Clone for ${repository.name} has local changes; not fast-forwarding`,
					);
				}
			} catch (e) {
				this.logger.warn(
					`Could not fast-forward ${branchName}: ${describeGitError(e)}`,
				);
			}
		}
		return {
			path: workspacePath,
			isGitWorktree: true,
			resolvedBaseBranches: { [repository.id]: extra.resolution },
			...extra.branchNames,
		};
	}

	/**
	 * Refuse a clone when free space is below max(2 x the source object
	 * database, 2 GB) (or the configured minimum): the copy is not hardlinked.
	 */
	private assertDiskSpace(sourceRepoPath: string, destParent: string): void {
		const objects = join(sourceRepoPath, ".git", "objects");
		let size = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else if (entry.isFile()) size += lstatSync(p).size;
			}
		};
		try {
			walk(objects);
		} catch {
			// unreadable object db: let git report it
		}
		const need = Math.max(2 * size, this.cloneMinFreeBytes);
		const fsStat = statfsSync(destParent);
		const free = fsStat.bavail * fsStat.bsize;
		if (free < need) {
			throw new Error(
				`Not enough free disk space to clone (${Math.floor(free / 1e6)} MB free, ${Math.floor(need / 1e6)} MB needed)`,
			);
		}
	}

	/**
	 * Delete the clone(s) for an issue: run the repos' teardown scripts, then
	 * remove the parent-chosen directory. No git command runs in the clone.
	 * (A leftover legacy linked worktree also has its admin dir in the shared
	 * repo removed, by validated name, without running git.)
	 *
	 * @param issueIdentifier - The workspace directory name (e.g., "DEF-123")
	 * @param options - Optional teardown wiring (see {@link DeleteWorktreeOptions})
	 */
	async deleteWorkspace(
		issueIdentifier: string,
		options: DeleteWorktreeOptions = {},
	): Promise<void> {
		const workspacePath = join(
			getDefaultWorktreesDir(this.kittuHome),
			issueIdentifier,
		);

		if (!existsSync(workspacePath)) {
			this.logger.info(
				`Workspace directory does not exist for ${issueIdentifier}, nothing to delete`,
			);
			return;
		}

		this.logger.info(
			`Deleting workspace directory for ${issueIdentifier} at ${workspacePath}`,
		);

		// Run per-repo teardown scripts before anything is removed.
		await this.runTeardownsForIssue({
			issueIdentifier,
			workspacePath,
			repositories: options.repositories,
		});

		// Legacy linked worktrees: drop their admin dir in the shared repo.
		for (const dir of [workspacePath, ...this.childDirs(workspacePath)]) {
			if (this.classifyWorkspaceDir(dir) !== "legacy-worktree") continue;
			for (const repo of options.repositories ?? []) {
				try {
					const name = this.gitEnv.resolveAdminName(repo.repositoryPath, dir);
					if (name) {
						this.removeAdminDir(repo.repositoryPath, name);
						break;
					}
				} catch {
					// not this repo
				}
			}
		}

		try {
			rmSync(workspacePath, { recursive: true, force: true });
			this.logger.info(`Deleted workspace directory for ${issueIdentifier}`);
		} catch (error) {
			this.logger.error(
				`Failed to delete workspace directory for ${issueIdentifier}: ${(error as Error).message}`,
			);
		}
	}

	/** @deprecated Kept for one release; use {@link deleteWorkspace}. */
	async deleteWorktree(
		issueIdentifier: string,
		options: DeleteWorktreeOptions = {},
	): Promise<void> {
		return this.deleteWorkspace(issueIdentifier, options);
	}

	private childDirs(dir: string): string[] {
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => join(dir, e.name));
		} catch {
			return [];
		}
	}

	/**
	 * Remove the parent's OWN admin dir `<common>/worktrees/<name>` of a legacy
	 * linked worktree (validated plain name, real directory). Never
	 * `git worktree prune`.
	 */
	private removeAdminDir(repositoryPath: string, adminName: string): void {
		if (!isPlainComponent(adminName)) return;
		try {
			const common = realpathSync.native(join(repositoryPath, ".git"));
			const dir = join(common, "worktrees", adminName);
			if (lstatSync(dir).isDirectory()) {
				rmSync(dir, { recursive: true, force: true });
			}
		} catch {
			// already gone
		}
	}

	/**
	 * Remove workspaces nobody can need any more. Candidates are PR clones
	 * (`<repo>-PR-<n>`, older than `maxAgeDays`) and set-aside directories
	 * (`*.quarantine-*`, `*.worktree-old-*`, older than 7 days). A workspace
	 * that a live or parked session references is never removed; Linear issue
	 * workspaces are governed by the terminal-state teardown only.
	 *
	 * @returns the directory names removed
	 */
	sweepWorkspaces(opts: {
		baseDirs: string[];
		isInUse: (path: string) => boolean;
		maxAgeDays: number;
		now?: number;
	}): string[] {
		const now = opts.now ?? Date.now();
		const removed: string[] = [];
		for (const baseDir of new Set(opts.baseDirs)) {
			let entries: string[];
			try {
				entries = readdirSync(baseDir);
			} catch {
				continue;
			}
			for (const name of entries) {
				const isAside = /\.(quarantine|worktree-old)-\d+$/.test(name);
				const isPr = /-(PR|MR)-\d+$/.test(name);
				if (!isAside && !isPr) continue;
				const path = join(baseDir, name);
				const maxAgeMs = (isAside ? 7 : opts.maxAgeDays) * 86_400_000;
				try {
					const st = lstatSync(path);
					if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
					if (opts.isInUse(path)) continue;
					rmSync(path, { recursive: true, force: true });
					removed.push(name);
				} catch (e) {
					this.logger.warn(
						`Sweep could not remove ${name}: ${(e as Error).message}`,
					);
				}
			}
		}
		if (removed.length > 0) {
			this.logger.info(
				`Swept ${removed.length} stale workspace(s): ${removed.join(", ")}`,
			);
		}
		return removed;
	}

	/**
	 * Cutover from linked worktrees to clones (plan section 9). For each
	 * top-level workspace directory containing legacy linked worktrees:
	 *  1. POINTER CHECKS before any git call (the directories are session
	 *     written): the gitfile must be exactly `gitdir: <repo>/.git/worktrees/<n>`
	 *     for a configured repo and plain `<n>`, `<admin>/commondir` must be
	 *     `../..`, the admin dir must resolve inside the repo's `worktrees`, and
	 *     `<admin>/gitdir` must equal `<ws>/.git`. Any failure: no git is run
	 *     there and the directory is set aside unexamined.
	 *  2. Dirty check (`status --porcelain --untracked-files=no`) under the
	 *     Stage A pins built from the verified values. Dirty directories stay
	 *     where they are unless `discard` is set (then they are set aside too).
	 *  3. Clean directories are set aside as `<dir>.worktree-old-<ts>` (kept 7
	 *     days by the sweep). Nothing is deleted and no `git worktree prune` or
	 *     `repair` runs.
	 *
	 * Returns directory NAMES only.
	 */
	migrateLegacyWorktrees(opts: {
		baseDirs: string[];
		repositories: RepositoryConfig[];
		isInUse?: (path: string) => boolean;
		discard?: boolean;
	}): { moved: string[]; dirty: string[]; invalid: string[] } {
		const result = {
			moved: [] as string[],
			dirty: [] as string[],
			invalid: [] as string[],
		};
		const repoRoots = new Map<string, RepositoryConfig>();
		for (const repo of opts.repositories) {
			try {
				repoRoots.set(realpathSync.native(repo.repositoryPath), repo);
			} catch {
				// unresolvable repo: nothing can be verified against it
			}
		}
		type Verdict = "ok" | "invalid" | "dirty";
		// Admin dirs whose pointers were verified: removed (by plain name) for
		// every worktree the cutover retires, so no dangling registration stays.
		let verified: Array<{ repositoryPath: string; adminName: string }> = [];
		const check = (wt: string): Verdict => {
			try {
				const m = readFileSync(join(wt, ".git"), "utf8")
					.trim()
					.match(/^gitdir: (.+)$/);
				if (!m?.[1]) return "invalid";
				const adminPath = m[1];
				const name = basename(adminPath);
				const rootCandidate = dirname(dirname(dirname(adminPath)));
				const repo = repoRoots.get(rootCandidate);
				if (
					!repo ||
					!isPlainComponent(name) ||
					adminPath !== join(rootCandidate, ".git", "worktrees", name)
				) {
					return "invalid";
				}
				const adminReal = realpathSync.native(adminPath);
				const worktreesReal = realpathSync.native(
					join(rootCandidate, ".git", "worktrees"),
				);
				if (dirname(adminReal) !== worktreesReal) return "invalid";
				if (
					readFileSync(join(adminPath, "commondir"), "utf8").trim() !== "../.."
				) {
					return "invalid";
				}
				if (
					readFileSync(join(adminPath, "gitdir"), "utf8").trim() !==
					join(realpathSync.native(wt), ".git")
				) {
					return "invalid";
				}
				verified.push({ repositoryPath: repo.repositoryPath, adminName: name });
				const inv = this.gitEnv.sessionScope({
					repositoryId: repo.id,
					repositoryPath: repo.repositoryPath,
					workspacePath: wt,
					adminName: name,
				});
				const status = this.gitEnv
					.run(inv, ["status", "--porcelain", "--untracked-files=no"])
					.trim();
				return status === "" ? "ok" : "dirty";
			} catch {
				return "invalid";
			}
		};
		for (const baseDir of new Set(opts.baseDirs)) {
			for (const top of this.childDirs(baseDir)) {
				if (/\.(quarantine|worktree-old)-\d+$/.test(top)) continue;
				const members = [top, ...this.childDirs(top)].filter(
					(d) => this.classifyWorkspaceDir(d) === "legacy-worktree",
				);
				if (members.length === 0) continue;
				if (opts.isInUse?.(top)) continue;
				verified = [];
				const verdicts = members.map(check);
				const topName = basename(top);
				if (verdicts.includes("invalid")) {
					result.invalid.push(topName);
				} else if (verdicts.includes("dirty") && !opts.discard) {
					result.dirty.push(topName);
					continue;
				}
				this.quarantine(top, "worktree-old");
				for (const { repositoryPath, adminName } of verified) {
					this.removeAdminDir(repositoryPath, adminName);
				}
				result.moved.push(topName);
			}
		}
		return result;
	}

	/**
	 * Run per-repo teardown scripts for each repository whose worktree is about
	 * to be removed. Prefers the explicit `repositories` list passed by the
	 * caller (source-of-truth from the session manager); falls back to inferring
	 * the repo mapping from `worktreePaths` (filesystem-driven) — i.e. matches
	 * each worktree subdirectory to a configured `RepositoryConfig` by
	 * `repository.repositoryPath`.
	 *
	 * Each repo's teardown runs with `cwd` set to its own worktree subdirectory.
	 * Failures are isolated: one repo failing does not skip subsequent repos
	 * and does not block worktree deletion.
	 */
	private async runTeardownsForIssue(opts: {
		issueIdentifier: string;
		workspacePath: string;
		repositories?: RepositoryConfig[];
	}): Promise<void> {
		const { issueIdentifier, workspacePath, repositories } = opts;

		// Build the worktree cwd list. Prefer the explicit list from the caller.
		const targets: string[] = [];

		if (repositories && repositories.length > 0) {
			if (repositories.length === 1) {
				// Single-repo layout: workspace root IS the worktree.
				targets.push(workspacePath);
			} else {
				// Multi-repo layout: each repo's worktree is a named subdir.
				for (const repo of repositories) {
					targets.push(join(workspacePath, repo.name));
				}
			}
		}

		if (targets.length === 0) {
			// No repos provided — nothing to do. The filesystem-driven fallback
			// would require the caller to provide a repository registry, which
			// the EdgeWorker is the source of truth for. Without it we skip
			// teardown rather than guessing.
			return;
		}

		for (const workspacePath of targets) {
			try {
				await this.runRepoTeardownScript(workspacePath, issueIdentifier);
			} catch (error) {
				// runRepoTeardownScript already swallows execSync failures and
				// logs them; this catch is defensive against unexpected throws
				// (e.g. unreadable directory) so one bad repo cannot abort the loop.
				this.logger.error(
					`Unexpected error running teardown for ${workspacePath}: ${(error as Error).message}`,
				);
			}
		}
	}

	/**
	 * Find and run a repository-specific setup script (kittu-setup.sh/.ps1/.cmd/.bat)
	 */
	private async runRepoSetupScript(
		workspacePath: string,
		issue: Issue,
		repositoryName?: string,
		onRepoSetupHookEvent?: RepoSetupHookEventHandler,
	): Promise<void> {
		await this.runRepoHookScript({
			hook: "setup",
			workspacePath,
			env: {
				LINEAR_ISSUE_ID: issue.id,
				LINEAR_ISSUE_IDENTIFIER: issue.identifier,
				LINEAR_ISSUE_TITLE: issue.title || "",
			},
			timeoutMs: SETUP_TIMEOUT_MS,
			repositoryName,
			issueIdentifier: issue.identifier,
			onRepoSetupHookEvent,
		});
	}

	/**
	 * Find and run a repository-specific teardown script (kittu-teardown.sh/.ps1/.cmd/.bat).
	 *
	 * Mirrors {@link runRepoSetupScript} but is invoked from {@link deleteWorktree}
	 * immediately before the worktree subdirectory is removed. Only
	 * `LINEAR_ISSUE_IDENTIFIER` is guaranteed in the teardown environment because
	 * the terminal-state message bus path does not carry the full Issue object.
	 */
	private async runRepoTeardownScript(
		workspacePath: string,
		issueIdentifier: string,
	): Promise<void> {
		await this.runRepoHookScript({
			hook: "teardown",
			workspacePath,
			env: {
				LINEAR_ISSUE_IDENTIFIER: issueIdentifier,
			},
			timeoutMs: TEARDOWN_TIMEOUT_MS,
		});
	}

	/**
	 * Shared discovery+dispatch for repo-scoped hook scripts (setup and teardown).
	 * Looks in `workspacePath` for `kittu-<hook>.{sh,ps1,cmd,bat}` and runs the
	 * first compatible variant with `cwd` set to `workspacePath`.
	 */
	private async runRepoHookScript(opts: {
		hook: HookKind;
		workspacePath: string;
		env: Record<string, string>;
		timeoutMs: number;
		repositoryName?: string;
		issueIdentifier?: string;
		onRepoSetupHookEvent?: RepoSetupHookEventHandler;
	}): Promise<void> {
		if (this.untrustedWorktree) {
			this.logger.info(
				`Untrusted-worktree mode: skipping repo ${opts.hook} hook scripts in ${opts.workspacePath}`,
			);
			return;
		}
		const isWindows = process.platform === "win32";
		const candidates = hookScriptCandidates(opts.hook);

		const available = candidates.find((c) => {
			const scriptPath = join(opts.workspacePath, c.file);
			const isCompatible = isWindows
				? c.platform === "windows"
				: c.platform === "unix";
			return existsSync(scriptPath) && isCompatible;
		});

		// Windows fallback: try bash variant when no Windows-native script exists.
		const fallback =
			!available && isWindows
				? candidates.find((c) => {
						const scriptPath = join(opts.workspacePath, c.file);
						return c.platform === "unix" && existsSync(scriptPath);
					})
				: null;

		const scriptToRun = available || fallback;
		if (!scriptToRun) return;

		const scriptPath = join(opts.workspacePath, scriptToRun.file);
		await this.runHookScript({
			scriptPath,
			hook: opts.hook,
			originLabel: "repository",
			cwd: opts.workspacePath,
			env: opts.env,
			timeoutMs: opts.timeoutMs,
			repositoryName: opts.repositoryName,
			issueIdentifier: opts.issueIdentifier,
			onRepoSetupHookEvent: opts.onRepoSetupHookEvent,
		});
	}

	private async emitRepoSetupHookEvent(
		handler: RepoSetupHookEventHandler | undefined,
		event: Parameters<RepoSetupHookEventHandler>[0],
	): Promise<void> {
		if (!handler) return;
		try {
			await handler(event);
		} catch (error) {
			this.logger.warn(
				`Failed to post repository setup hook activity: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Run a hook script (setup or teardown) with proper error handling and logging.
	 * Failure is non-blocking — errors are logged and execution continues.
	 */
	private async runHookScript(opts: HookScriptOptions): Promise<void> {
		const {
			scriptPath,
			hook,
			originLabel,
			cwd,
			env,
			timeoutMs,
			repositoryName,
			issueIdentifier,
			onRepoSetupHookEvent,
		} = opts;

		// Expand ~ to home directory
		const expandedPath = scriptPath.replace(/^~/, homedir());
		const labelTitle = `${originLabel.charAt(0).toUpperCase()}${originLabel.slice(1)} ${hook}`;
		const scriptName = basename(expandedPath);
		const shouldPostRepoSetupActivity = Boolean(
			originLabel === "repository" &&
				hook === "setup" &&
				issueIdentifier &&
				onRepoSetupHookEvent,
		);
		const startedAt = Date.now();

		if (!existsSync(expandedPath)) {
			this.logger.warn(`⚠️  ${labelTitle} script not found: ${scriptPath}`);
			return;
		}

		const runsThroughInterpreter =
			expandedPath.endsWith(".sh") || expandedPath.endsWith(".ps1");

		// Preserve legacy permission checks outside the Linear-visible repo setup
		// path. For visible repo setup hooks, interpreter-run scripts do not need
		// the executable bit because we invoke them as `bash script`.
		if (
			process.platform !== "win32" &&
			(!shouldPostRepoSetupActivity || !runsThroughInterpreter)
		) {
			try {
				const stats = statSync(expandedPath);
				if (!(stats.mode & 0o100)) {
					this.logger.warn(
						`⚠️  ${labelTitle} script is not executable: ${scriptPath}`,
					);
					this.logger.warn(`   Run: chmod +x "${expandedPath}"`);
					if (shouldPostRepoSetupActivity) {
						await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
							status: "failed",
							issueIdentifier: issueIdentifier!,
							scriptName,
							repositoryName,
							durationMs: Date.now() - startedAt,
							errorMessage: "Repository setup hook is not executable",
							stderrTail: `Make ${scriptName} executable in the repository and commit the executable bit: git update-index --chmod=+x ${scriptName}`,
							truncated: false,
						});
					}
					return;
				}
			} catch (error) {
				this.logger.warn(
					`⚠️  Cannot check permissions for ${labelTitle.toLowerCase()} script: ${(error as Error).message}`,
				);
				return;
			}
		}

		this.logger.info(
			`ℹ️  Running ${labelTitle.toLowerCase()} script: ${scriptName}`,
		);

		if (shouldPostRepoSetupActivity) {
			await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
				status: "started",
				issueIdentifier: issueIdentifier!,
				scriptName,
				repositoryName,
			});
		}

		try {
			if (!shouldPostRepoSetupActivity) {
				this.runHookScriptInherited({
					scriptPath,
					expandedPath,
					cwd,
					env,
					timeoutMs,
				});

				this.logger.info(`✅ ${labelTitle} script completed successfully`);
				return;
			}

			let command: string;
			let args: string[];
			let shell = false;
			const isWindows = process.platform === "win32";
			if (scriptPath.endsWith(".ps1")) {
				command = "powershell";
				args = ["-ExecutionPolicy", "Bypass", "-File", expandedPath];
			} else if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
				command = expandedPath;
				args = [];
				shell = true;
			} else if (isWindows) {
				command = "bash";
				args = [expandedPath];
			} else {
				command = "bash";
				args = [expandedPath];
			}

			const stdoutCollector = new HookOutputCollector();
			const stderrCollector = new HookOutputCollector();
			await new Promise<void>((resolve, reject) => {
				const child = spawn(command, args, {
					cwd,
					env: {
						...process.env,
						...env,
					},
					shell,
				});
				let timedOut = false;
				const timeout = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeoutMs);

				child.stdout?.on("data", (chunk: Buffer) => {
					stdoutCollector.append(chunk);
					process.stdout.write(chunk);
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderrCollector.append(chunk);
					process.stderr.write(chunk);
				});
				child.on("error", (error) => {
					clearTimeout(timeout);
					(error as NodeExecError).message = error.message;
					reject(error);
				});
				child.on("close", (code, signal) => {
					clearTimeout(timeout);
					if (code === 0) {
						resolve();
						return;
					}
					const error = new Error(
						timedOut
							? "Script execution timed out"
							: `Script exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
					) as Error &
						NodeExecError & { stdoutTail?: string; stderrTail?: string };
					error.code = code === null ? undefined : code;
					error.signal = timedOut ? "SIGTERM" : (signal ?? undefined);
					const stdoutTail = stdoutCollector.tail({ cwd, env });
					const stderrTail = stderrCollector.tail({ cwd, env });
					error.stdoutTail = stdoutTail.text;
					error.stderrTail = stderrTail.text;
					(
						error as typeof error & { outputTruncated?: boolean }
					).outputTruncated = stdoutTail.truncated || stderrTail.truncated;
					reject(error);
				});
			});

			this.logger.info(`✅ ${labelTitle} script completed successfully`);
			if (shouldPostRepoSetupActivity) {
				await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
					status: "succeeded",
					issueIdentifier: issueIdentifier!,
					scriptName,
					repositoryName,
					durationMs: Date.now() - startedAt,
				});
			}
		} catch (error) {
			const timeoutMinutes = Math.round(timeoutMs / 60_000);
			const isTimeout = isNodeExecError(error) && error.signal === "SIGTERM";
			const errorMessage = isTimeout
				? `Script execution timed out (exceeded ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"})`
				: error instanceof Error
					? error.message
					: String(error);

			this.logger.error(`❌ ${labelTitle} script failed: ${errorMessage}`);
			this.logger.info(`   Continuing despite ${hook} script failure...`);
			if (shouldPostRepoSetupActivity) {
				const nodeError = error as NodeExecError & {
					stdoutTail?: unknown;
					stderrTail?: unknown;
					outputTruncated?: unknown;
				};
				const stdoutTail =
					typeof nodeError.stdoutTail === "string"
						? nodeError.stdoutTail
						: undefined;
				const stderrTail =
					typeof nodeError.stderrTail === "string"
						? nodeError.stderrTail
						: undefined;
				await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
					status: "failed",
					issueIdentifier: issueIdentifier!,
					scriptName,
					repositoryName,
					durationMs: Date.now() - startedAt,
					exitCode:
						typeof nodeError.code === "number" ? nodeError.code : undefined,
					signal: nodeError.signal,
					errorMessage: redactHookOutput(errorMessage, { cwd, env }),
					stdoutTail,
					stderrTail,
					truncated: nodeError.outputTruncated === true,
				});
			}
		}
	}

	private runHookScriptInherited(opts: {
		scriptPath: string;
		expandedPath: string;
		cwd: string;
		env: Record<string, string>;
		timeoutMs: number;
	}): void {
		const { scriptPath, expandedPath, cwd, env, timeoutMs } = opts;
		let command: string;
		const isWindows = process.platform === "win32";
		if (scriptPath.endsWith(".ps1")) {
			command = `powershell -ExecutionPolicy Bypass -File "${expandedPath}"`;
		} else if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
			command = `"${expandedPath}"`;
		} else if (isWindows) {
			command = `bash "${expandedPath}"`;
		} else {
			command = `bash "${expandedPath}"`;
		}

		execSync(command, {
			cwd,
			stdio: "inherit",
			env: {
				...process.env,
				...env,
			},
			timeout: timeoutMs,
		});
	}

	/**
	 * Find and run a global setup script (path resolved from EdgeConfig).
	 * Kept as a thin wrapper to preserve the existing call sites.
	 */
	private async runSetupScript(
		scriptPath: string,
		scriptType: "global" | "repository",
		workspacePath: string,
		issue: Issue,
	): Promise<void> {
		await this.runHookScript({
			scriptPath,
			hook: "setup",
			originLabel: scriptType,
			cwd: workspacePath,
			env: {
				LINEAR_ISSUE_ID: issue.id,
				LINEAR_ISSUE_IDENTIFIER: issue.identifier,
				LINEAR_ISSUE_TITLE: issue.title || "",
			},
			timeoutMs: SETUP_TIMEOUT_MS,
		});
	}
}

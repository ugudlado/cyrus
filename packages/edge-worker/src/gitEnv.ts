import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { ILogger } from "kittu-core";

/**
 * Parent-side git environment.
 *
 * The Kittu process runs git and gh unsandboxed, in directories a sandboxed
 * session can write (its worktree, `.git` pointer files, a clone's `.git`).
 * Anything git discovers from there (a rewritten `commondir` or gitfile, a
 * planted `core.fsmonitor`, hooks, `url.*.insteadOf`) would run or redirect
 * with the Kittu process's privileges and credentials. So every parent git
 * call:
 *   - gets its repository location from paths the PARENT owns (GIT_DIR,
 *     GIT_COMMON_DIR, GIT_WORK_TREE), never discovered from the workspace;
 *   - gets the dangerous config keys pinned through GIT_CONFIG_COUNT, which
 *     beats every config file including the repo-local one;
 *   - runs via execFileSync (no shell) with a minimal explicit env.
 *
 * This env is built per call and passed as `env:` to the child only. It must
 * NEVER be put in the Kittu service env or a session's env: sessions inherit
 * the parent env and would lose the project's own git hooks.
 *
 * The base env is minimal on purpose (PASSTHROUGH_ENV). It intentionally drops
 * GIT_SSL_CAINFO, SSL_CERT_FILE and XDG_CONFIG_HOME: the first two would break
 * the parent's own fetches (CLAUDE.md note 5) and the third would let a
 * different user-level git config apply.
 */

/**
 * The pinned config keys, one `key=value` per line, in order. boat/setup.sh
 * `git_env_content` carries the same list for the shell callers (repo-sync,
 * setup); a boat test keeps the two equal. Keep this a single block of plain
 * lines so that test can extract it.
 *
 * `@HOOKS_DIR@` and `@CRED@` are filled in per deployment. The three
 * `credential.*` lines are dropped when no credential helper is configured
 * (the ambient helper then applies).
 */
// BEGIN git-env-keys
const GIT_ENV_KEYS = `
core.hooksPath=@HOOKS_DIR@
core.fsmonitor=false
credential.helper=
credential.https://github.com.helper=
credential.https://github.com.helper=@CRED@
credential.https://github.com.useHttpPath=true
core.sshCommand=/bin/false
core.gitProxy=
http.proxy=
protocol.allow=never
protocol.https.allow=always
gc.auto=0
maintenance.auto=false
fetch.recurseSubmodules=false
merge.verifySignatures=false
gpg.program=/bin/false
`;

const GIT_ENV_VARS = `
GIT_SSH_COMMAND=/bin/false
GIT_ASKPASS=/bin/false
SSH_ASKPASS=/bin/false
GIT_PAGER=cat
GIT_TERMINAL_PROMPT=0
GIT_NO_REPLACE_OBJECTS=1
`;
// END git-env-keys

/** Keys that must never reach a session env (asserted by a test). */
export const GIT_ENV_FORBIDDEN_IN_SESSION: readonly string[] = [
	"GIT_CONFIG_COUNT",
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
];

const PASSTHROUGH_ENV = [
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"NO_PROXY",
	"no_proxy",
];

/** Fixed PATH for gh: excludes /usr/local/bin, where the token shim lives. */
const GH_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

export class GitEnvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitEnvError";
	}
}

export interface GitEnvOptions {
	kittuHome: string;
	/** Empty directory for core.hooksPath. Defaults to `<kittuHome>/no-hooks`. */
	hooksDir?: string;
	/** Credential helper path for network calls. Unset: ambient helper. */
	credentialHelper?: string;
	/** Absolute path of the real gh. Unset: gh is never run. */
	ghBinary?: string;
	/** Tests only (boat's `git_env_content ... file`): also allow `file` URLs. */
	allowFileProtocol?: boolean;
	logger?: ILogger;
}

export interface GitInvocation {
	/** Complete child env (never merged with process.env by the caller). */
	env: Record<string, string>;
	cwd: string;
}

export interface GitSessionTarget {
	repositoryId: string;
	/** Configured (parent-owned) repository path. */
	repositoryPath: string;
	/** The worktree directory the parent created for this repo. */
	workspacePath: string;
	/** Parent-recorded admin dir name; resolved once from the repo when absent. */
	adminName?: string;
	/** Branch the PARENT created for the session. */
	branchName?: string;
	/** `RepositoryConfig.githubUrl` (trusted config); names the repo for scoped tokens. */
	githubUrl?: string;
	/** Token-store entry for `githubUrl`, resolved by the parent. */
	storeToken?: string;
}

/** Mints installation tokens limited to given repositories and permissions. */
export interface ScopedGhTokenSource {
	getScopedToken(options: {
		repositories: string[];
		permissions: Record<string, "read" | "write">;
	}): Promise<string>;
}

/** True for a single, plain path component. */
export function isPlainComponent(name: string): boolean {
	return (
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0")
	);
}

function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function insideDir(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** `owner/name` from a github.com remote URL, or null. */
export function parseGithubSlug(url: string): string | null {
	const m =
		/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
			url.trim(),
		);
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Check every `<commonDir>/worktrees/<id>/gitdir` before any `git worktree
 * repair` or `prune` could act on it. `gitdir` is session-writable: repair
 * writes a gitfile at the recorded path (arbitrary file overwrite) and prune
 * deletes admin dirs whose target is missing (cross-session DoS). Each entry
 * must be a real directory whose `gitdir` equals exactly
 * `<realpath(worktreesRoot)>/<comp>(/<comp>)?/.git`.
 *
 * The parent itself no longer calls repair or prune; this is the gate for
 * anything that does (migration, cutover).
 */
export function validateWorktreeGitdirs(
	commonDir: string,
	worktreesRoot: string,
): { ok: boolean; invalid: string[] } {
	const invalid: string[] = [];
	let root: string;
	try {
		root = realpathSync.native(worktreesRoot);
	} catch {
		return { ok: false, invalid: ["<worktrees root unresolvable>"] };
	}
	const adminRoot = join(commonDir, "worktrees");
	let ids: string[] = [];
	try {
		ids = readdirSync(adminRoot);
	} catch {
		return { ok: true, invalid };
	}
	const comp = "[^/\\0]+";
	const expected = new RegExp(
		`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(${comp})(?:/(${comp}))?/\\.git$`,
	);
	for (const id of ids) {
		const dir = join(adminRoot, id);
		let good = false;
		if (isPlainComponent(id) && isRealDirectory(dir)) {
			try {
				const content = readFileSync(join(dir, "gitdir"), "utf8").trim();
				const m = expected.exec(content);
				if (m && m[1] !== ".." && m[2] !== "..") {
					const parent = content.slice(0, -"/.git".length);
					// An existing parent must resolve inside the root (no symlink escape).
					if (!existsSync(parent)) {
						good = true;
					} else {
						good = insideDir(realpathSync.native(parent), root);
					}
				}
			} catch {
				good = false;
			}
		}
		if (!good) invalid.push(id);
	}
	return { ok: invalid.length === 0, invalid };
}

export class GitEnv {
	private kittuHome: string;
	private hooksDirPath: string;
	private credentialHelper?: string;
	private ghBinaryPath?: string;
	private allowFile: boolean;
	private logger?: ILogger;

	constructor(options: GitEnvOptions) {
		this.kittuHome = options.kittuHome;
		this.hooksDirPath = options.hooksDir ?? join(options.kittuHome, "no-hooks");
		this.credentialHelper = options.credentialHelper;
		this.ghBinaryPath = options.ghBinary;
		this.allowFile = options.allowFileProtocol ?? false;
		this.logger = options.logger;
	}

	get ghBinary(): string | undefined {
		return this.ghBinaryPath;
	}

	get home(): string {
		return this.kittuHome;
	}

	/** The empty hooks dir; verified empty on EVERY use. */
	private verifiedHooksDir(): string {
		if (!existsSync(this.hooksDirPath)) {
			mkdirSync(this.hooksDirPath, { recursive: true, mode: 0o755 });
		}
		if (!isRealDirectory(this.hooksDirPath)) {
			throw new GitEnvError("git hooks dir is not a directory");
		}
		if (readdirSync(this.hooksDirPath).length > 0) {
			throw new GitEnvError("git hooks dir is not empty; refusing to run git");
		}
		return this.hooksDirPath;
	}

	/** Config pins as [key, value] pairs, in the order of the key block. */
	configPairs(): Array<[string, string]> {
		const hooks = this.verifiedHooksDir();
		const pairs: Array<[string, string]> = [];
		for (const line of GIT_ENV_KEYS.split("\n")) {
			if (!line) continue;
			const i = line.indexOf("=");
			const key = line.slice(0, i);
			const raw = line.slice(i + 1);
			if (key.startsWith("credential.") && !this.credentialHelper) continue;
			pairs.push([
				key,
				raw === "@HOOKS_DIR@"
					? hooks
					: raw === "@CRED@"
						? (this.credentialHelper as string)
						: raw,
			]);
		}
		if (this.allowFile) pairs.push(["protocol.file.allow", "always"]);
		return pairs;
	}

	/** Minimal base env + config pins, no repository location. */
	private pinnedEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const k of PASSTHROUGH_ENV) {
			const v = process.env[k];
			if (v !== undefined) env[k] = v;
		}
		env.PATH = process.env.PATH ?? "/usr/bin:/bin";
		const pairs = this.configPairs();
		env.GIT_CONFIG_COUNT = String(pairs.length);
		pairs.forEach(([k, v], i) => {
			env[`GIT_CONFIG_KEY_${i}`] = k;
			env[`GIT_CONFIG_VALUE_${i}`] = v;
		});
		for (const line of GIT_ENV_VARS.split("\n")) {
			if (!line) continue;
			const i = line.indexOf("=");
			env[line.slice(0, i)] = line.slice(i + 1);
		}
		return env;
	}

	/** Real `<repositoryPath>/.git` directory, or throws. */
	private commonDirOf(repositoryPath: string): {
		repo: string;
		common: string;
	} {
		let repo: string;
		try {
			repo = realpathSync.native(repositoryPath);
		} catch {
			throw new GitEnvError("repository path is not resolvable");
		}
		const common = join(repo, ".git");
		if (!isRealDirectory(common)) {
			throw new GitEnvError("repository has no .git directory");
		}
		return { repo, common: realpathSync.native(common) };
	}

	/** Repo-scope pins: calls made in `~/repos/<name>` itself. */
	repoScope(repositoryPath: string): GitInvocation {
		const { repo, common } = this.commonDirOf(repositoryPath);
		return {
			cwd: repo,
			env: {
				...this.pinnedEnv(),
				GIT_DIR: common,
				GIT_COMMON_DIR: common,
				GIT_WORK_TREE: repo,
			},
		};
	}

	/**
	 * Admin dir names under `<common>/worktrees` whose `gitdir` equals
	 * `<workspace>/.git`. Used once, at add time (before any session exists:
	 * a before/after listing diff) or to restore a record without the name.
	 */
	listAdminDirs(repositoryPath: string): string[] {
		const { common } = this.commonDirOf(repositoryPath);
		try {
			return readdirSync(join(common, "worktrees")).filter(
				(n) =>
					isPlainComponent(n) && isRealDirectory(join(common, "worktrees", n)),
			);
		} catch {
			return [];
		}
	}

	/**
	 * Resolve the admin dir of `workspacePath` by exact `gitdir` match. Exactly
	 * one match or null (none or ambiguous: the caller skips the git call).
	 * No basename fallback.
	 */
	resolveAdminName(
		repositoryPath: string,
		workspacePath: string,
	): string | null {
		const { common } = this.commonDirOf(repositoryPath);
		let want: string;
		try {
			// The directory may be gone (stale registration): resolve its parent.
			want = join(
				existsSync(workspacePath)
					? realpathSync.native(workspacePath)
					: join(
							realpathSync.native(dirname(workspacePath)),
							basename(workspacePath),
						),
				".git",
			);
		} catch {
			return null;
		}
		const matches: string[] = [];
		for (const name of this.listAdminDirs(repositoryPath)) {
			try {
				const g = readFileSync(
					join(common, "worktrees", name, "gitdir"),
					"utf8",
				).trim();
				if (g === want) matches.push(name);
			} catch {
				// unreadable entry: not a match
			}
		}
		return matches.length === 1 ? (matches[0] as string) : null;
	}

	/** Session-scope pins: calls made with cwd inside a linked worktree. */
	sessionScope(target: GitSessionTarget, cwd?: string): GitInvocation {
		const { common } = this.commonDirOf(target.repositoryPath);
		let adminName = target.adminName;
		if (!adminName) {
			const resolved = this.resolveAdminName(
				target.repositoryPath,
				target.workspacePath,
			);
			if (!resolved) {
				throw new GitEnvError(
					"cannot resolve the worktree admin dir (none or ambiguous)",
				);
			}
			adminName = resolved;
		}
		if (!isPlainComponent(adminName)) {
			throw new GitEnvError("invalid worktree admin dir name");
		}
		const adminDir = join(common, "worktrees", adminName);
		if (!isRealDirectory(adminDir)) {
			throw new GitEnvError("worktree admin dir is not a real directory");
		}
		let workTree: string;
		try {
			workTree = realpathSync.native(target.workspacePath);
		} catch {
			throw new GitEnvError("workspace path is not resolvable");
		}
		return {
			cwd: cwd ?? workTree,
			env: {
				...this.pinnedEnv(),
				GIT_COMMON_DIR: common,
				GIT_DIR: adminDir,
				GIT_WORK_TREE: workTree,
			},
		};
	}

	/**
	 * Env for gh: git pins (no location), an explicit GH_TOKEN, an EMPTY
	 * throwaway GH_CONFIG_DIR (no stored login, aliases or pager settings) and a
	 * fixed PATH without the token shim. The caller runs `ghBinary` by absolute
	 * path from `neutralCwd` and calls `cleanup()`.
	 */
	ghScope(token: string | undefined): {
		binary: string;
		cwd: string;
		env: Record<string, string>;
		cleanup: () => void;
	} {
		if (!this.ghBinaryPath) throw new GitEnvError("ghBinary is not configured");
		mkdirSync(this.kittuHome, { recursive: true });
		const configDir = mkdtempSync(join(tmpdir(), "kittu-gh-"));
		const env = this.pinnedEnv();
		env.PATH = GH_PATH;
		env.GH_CONFIG_DIR = configDir;
		env.GH_PROMPT_DISABLED = "1";
		env.GH_NO_UPDATE_NOTIFIER = "1";
		if (token) env.GH_TOKEN = token;
		return {
			binary: this.ghBinaryPath,
			cwd: this.kittuHome,
			env,
			cleanup: () => rmSync(configDir, { recursive: true, force: true }),
		};
	}

	/**
	 * Pins WITHOUT a repository location, for `git clone` (which must create
	 * its own git dir: GIT_DIR in the env would redirect it) and for calls that
	 * need no repository. `cwd` is a parent-owned directory.
	 */
	plainScope(cwd: string): GitInvocation {
		return { cwd, env: this.pinnedEnv() };
	}

	/**
	 * Verify that `<workspace>/.git` is the standalone clone the parent made and
	 * not something a session turned into a pointer: a real directory, no
	 * `commondir`, no `objects/info/alternates`, no symlinked `hooks`, `objects`,
	 * `refs`, `info` or `config`, a plain HEAD, and a realpath inside the
	 * workspace. Run before ANY parent git call in an existing clone. Returns the
	 * real paths; throws GitEnvError otherwise.
	 */
	assertCloneShape(workspacePath: string): {
		workTree: string;
		gitDir: string;
	} {
		let workTree: string;
		try {
			workTree = realpathSync.native(workspacePath);
		} catch {
			throw new GitEnvError("clone: workspace is not resolvable");
		}
		const gitPath = join(workTree, ".git");
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(gitPath);
		} catch {
			throw new GitEnvError("clone: .git is missing");
		}
		if (st.isSymbolicLink() || !st.isDirectory()) {
			throw new GitEnvError("clone: .git is not a real directory");
		}
		const gitDir = realpathSync.native(gitPath);
		if (!insideDir(gitDir, workTree) || gitDir !== gitPath) {
			throw new GitEnvError("clone: .git resolves outside the workspace");
		}
		if (existsSync(join(gitDir, "commondir"))) {
			throw new GitEnvError("clone: .git/commondir present");
		}
		if (existsSync(join(gitDir, "objects", "info", "alternates"))) {
			throw new GitEnvError("clone: objects/info/alternates present");
		}
		// No symlink ANYWHERE under .git (objects/pack, refs/remotes, logs/...):
		// git and the parent's reads would follow it out of the clone.
		const walk = (dir: string, rel: string): void => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				throw new GitEnvError(`clone: cannot read .git/${rel}`);
			}
			for (const entry of entries) {
				const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
				if (entry.isSymbolicLink()) {
					throw new GitEnvError(`clone: .git/${entryRel} is a symlink`);
				}
				if (entry.isDirectory()) walk(join(dir, entry.name), entryRel);
			}
		};
		walk(gitDir, "");
		try {
			const cfg = lstatSync(join(gitDir, "config"));
			if (!cfg.isFile()) throw new GitEnvError("clone: .git/config not a file");
		} catch (err) {
			if (err instanceof GitEnvError) throw err;
		}
		let head: string;
		try {
			const headStat = lstatSync(join(gitDir, "HEAD"));
			if (!headStat.isFile()) throw new GitEnvError("clone: HEAD not a file");
			head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		} catch (err) {
			if (err instanceof GitEnvError) throw err;
			throw new GitEnvError("clone: HEAD is unreadable");
		}
		if (
			!/^ref: refs\/heads\/\S+$/.test(head) &&
			!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)
		) {
			throw new GitEnvError("clone: HEAD is not a branch ref or object id");
		}
		return { workTree, gitDir };
	}

	private neutralCwd(): string {
		mkdirSync(this.kittuHome, { recursive: true });
		return this.kittuHome;
	}

	/** Clone-scope pins: GIT_DIR=GIT_COMMON_DIR=<ws>/.git after the shape check. */
	cloneScope(workspacePath: string, cwd?: string): GitInvocation {
		const { workTree, gitDir } = this.assertCloneShape(workspacePath);
		return {
			cwd: cwd ?? workTree,
			env: {
				...this.pinnedEnv(),
				GIT_DIR: gitDir,
				GIT_COMMON_DIR: gitDir,
				GIT_WORK_TREE: workTree,
			},
		};
	}

	/**
	 * Rewrite `<ws>/.git/config` from scratch with the parent's fixed content
	 * (atomic temp + rename; the rename replaces a symlink, it does not follow
	 * it). Only these session settings survive: `user.name`, `user.email` and a
	 * relative, non-escaping `core.hooksPath` (a husky-style project hooks
	 * dir). Everything else, including anything planted, is dropped. The
	 * parent's security rests on the env pins and the shape check, not on this.
	 */
	restampCloneConfig(
		workspacePath: string,
		opts: { remoteUrl?: string; branch?: string },
	): void {
		const { gitDir } = this.assertCloneShape(workspacePath);
		const keep: string[] = [];
		const readKey = (key: string): string | undefined => {
			try {
				const out = execFileSync(
					"git",
					[
						"config",
						"--file",
						join(gitDir, "config"),
						"--no-includes",
						"--get",
						key,
					],
					{
						// Neutral cwd: nothing is discovered from the workspace.
						cwd: this.neutralCwd(),
						env: { ...this.pinnedEnv(), GIT_CONFIG_COUNT: "0" },
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					},
				).trim();
				return out || undefined;
			} catch {
				return undefined;
			}
		};
		const quote = (v: string) =>
			`"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		const name = readKey("user.name");
		const email = readKey("user.email");
		const hooksPath = readKey("core.hooksPath");
		if (name || email) {
			keep.push("[user]");
			if (name && !/[\n\r]/.test(name)) keep.push(`\tname = ${quote(name)}`);
			if (email && !/[\n\r]/.test(email))
				keep.push(`\temail = ${quote(email)}`);
		}
		if (
			hooksPath &&
			!hooksPath.startsWith("/") &&
			!hooksPath.split("/").includes("..") &&
			!/[\n\r"]/.test(hooksPath)
		) {
			keep.push("[core]", `\thooksPath = ${quote(hooksPath)}`);
		}
		const lines = [
			"[core]",
			"\trepositoryformatversion = 0",
			"\tfilemode = true",
			"\tbare = false",
			"\tlogallrefupdates = true",
		];
		if (opts.remoteUrl) {
			lines.push(
				'[remote "origin"]',
				`\turl = ${quote(opts.remoteUrl)}`,
				"\tfetch = +refs/heads/*:refs/remotes/origin/*",
			);
		}
		if (opts.branch && opts.remoteUrl) {
			lines.push(
				`[branch ${quote(opts.branch)}]`,
				"\tremote = origin",
				`\tmerge = ${quote(`refs/heads/${opts.branch}`)}`,
			);
		}
		const tmp = join(gitDir, `config.restamp-${process.pid}-${Date.now()}`);
		writeFileSync(tmp, `${[...lines, ...keep].join("\n")}\n`, { mode: 0o600 });
		renameSync(tmp, join(gitDir, "config"));
	}

	/** Run git under `inv`. Throws like execFileSync. */
	run(
		inv: GitInvocation,
		args: string[],
		opts: { input?: string; timeout?: number } = {},
	): string {
		return execFileSync("git", args, {
			cwd: inv.cwd,
			env: inv.env,
			encoding: "utf8",
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			...(opts.input === undefined ? {} : { input: opts.input }),
			...(opts.timeout ? { timeout: opts.timeout } : {}),
		});
	}

	/**
	 * The repository's remote URL for network calls, read under the repo pins,
	 * with the insteadOf post-check: `ls-remote --get-url <url>` prints the URL
	 * after rewriting, and must equal the URL. A mismatch (a planted
	 * `url.<evil>.insteadOf`) throws and the caller skips every network call.
	 */
	trustedRemoteUrl(inv: GitInvocation): string {
		const url = this.run(inv, ["config", "--get", "remote.origin.url"]).trim();
		if (!url) throw new GitEnvError("repository has no remote.origin.url");
		const rewritten = this.run(inv, ["ls-remote", "--get-url", url]).trim();
		if (rewritten !== url) {
			this.logger?.warn(
				"Remote URL is rewritten by url.*.insteadOf config; skipping network git for this repository",
			);
			throw new GitEnvError("remote URL is rewritten by insteadOf");
		}
		return url;
	}
}

/** Resolves pinned git invocations for a session from its cwd. */
export class SessionGit {
	private adminNames = new Map<string, string>();

	constructor(
		readonly gitEnv: GitEnv,
		private targets: GitSessionTarget[],
		private logger?: ILogger,
	) {}

	/** The target whose worktree contains `cwd` (longest match), or null. */
	targetFor(cwd: string): GitSessionTarget | null {
		let real: string;
		try {
			real = realpathSync.native(cwd);
		} catch {
			return null;
		}
		let best: { t: GitSessionTarget; len: number } | null = null;
		for (const t of this.targets) {
			let ws: string;
			try {
				ws = realpathSync.native(t.workspacePath);
			} catch {
				continue;
			}
			if (insideDir(real, ws) && (!best || ws.length > best.len)) {
				best = { t, len: ws.length };
			}
		}
		return best?.t ?? null;
	}

	/** Pinned invocation for `cwd`, or null (logged) when it cannot be trusted. */
	invocationFor(cwd: string): GitInvocation | null {
		const target = this.targetFor(cwd);
		if (!target) return null;
		try {
			// A standalone clone (Stage B): pins come from the clone itself after
			// the shape check. A `.git` FILE is a legacy linked worktree (Stage A).
			if (isRealDirectory(join(target.workspacePath, ".git"))) {
				return this.gitEnv.cloneScope(target.workspacePath, cwd);
			}
			const key = target.workspacePath;
			const adminName = target.adminName ?? this.adminNames.get(key);
			const inv = this.gitEnv.sessionScope({ ...target, adminName }, cwd);
			if (!adminName) {
				const resolved = this.gitEnv.resolveAdminName(
					target.repositoryPath,
					target.workspacePath,
				);
				if (resolved) this.adminNames.set(key, resolved);
			}
			return inv;
		} catch (err) {
			this.logger?.debug(
				`git skipped for ${target.repositoryId}: ${(err as Error).message}`,
			);
			return null;
		}
	}

	/** Context for running gh against the PR of the session's own branch. */
	async ghContextFor(
		cwd: string,
		tokens: { appTokens?: ScopedGhTokenSource; envToken?: string },
	): Promise<{
		binary: string;
		cwd: string;
		env: Record<string, string>;
		slug: string;
		branch: string;
		cleanup: () => void;
	} | null> {
		const target = this.targetFor(cwd);
		if (!target?.branchName || !this.gitEnv.ghBinary) return null;
		try {
			const repoInv = this.gitEnv.repoScope(target.repositoryPath);
			const url = this.gitEnv
				.run(repoInv, ["config", "--get", "remote.origin.url"])
				.trim();
			const slug = parseGithubSlug(url);
			if (!slug) return null;
			// Token tiers: the token-store entry for the repo URL, then an App
			// token scoped to THIS repo (name from the trusted config, minted now),
			// then the env PAT. When an App is configured, a mint failure means no
			// token and no marker (it does not fall through to the PAT).
			let token = target.storeToken;
			if (!token && tokens.appTokens) {
				if (!target.githubUrl) return null;
				const repoName = parseGithubSlug(target.githubUrl)?.split("/")[1];
				if (!repoName) return null;
				try {
					token = await tokens.appTokens.getScopedToken({
						repositories: [repoName],
						permissions: { pull_requests: "write" },
					});
				} catch (err) {
					const status = (err as { status?: number }).status;
					this.logger?.warn(
						`gh marker skipped for ${repoName}: scoped token mint failed (HTTP ${status ?? "n/a"})`,
					);
					return null;
				}
			} else {
				token ||= tokens.envToken;
			}
			const gh = this.gitEnv.ghScope(token);
			return { ...gh, slug, branch: target.branchName };
		} catch (err) {
			this.logger?.debug(`gh skipped: ${(err as Error).message}`);
			return null;
		}
	}
}

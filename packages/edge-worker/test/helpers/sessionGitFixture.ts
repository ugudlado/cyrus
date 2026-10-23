import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitEnv, type GitSessionTarget, SessionGit } from "../../src/gitEnv.js";

const IDENT = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Plain git for building fixtures (not the code under test). */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...IDENT },
	});
}

export interface SessionFixture {
	root: string;
	/** Main checkout (configured repositoryPath), HEAD detached. */
	repo: string;
	/** The session's linked worktree, on `branch`. */
	ws: string;
	branch: string;
	/** Bare remote, when requested. */
	remote?: string;
	gitEnv: GitEnv;
	sessionGit: SessionGit;
	target: GitSessionTarget;
	cleanup(): void;
}

/**
 * A real repository with a real linked worktree, the layout of a Cyrus
 * session: main checkout (detached so the worktree can hold the branch),
 * worktree `ws` on `main`, optional bare remote with `main` pushed and set as
 * upstream.
 */
export function makeSessionFixture(
	opts: { remote?: boolean; branch?: string } = {},
): SessionFixture {
	const root = mkdtempSync(join(tmpdir(), "cyrus-git-session-"));
	const repo = join(root, "repo");
	const ws = join(root, "worktrees", "ENG-1");
	const branch = opts.branch ?? "main";
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(root, "worktrees"), { recursive: true });
	git(repo, "init", "-b", "main");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "init");
	let remote: string | undefined;
	if (opts.remote) {
		remote = join(root, "remote.git");
		git(root, "init", "--bare", remote);
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "-u", "origin", "main");
	}
	git(repo, "checkout", "--detach");
	if (branch === "main") {
		git(repo, "worktree", "add", ws, "main");
	} else {
		git(repo, "worktree", "add", "-b", branch, ws, "main");
	}
	const gitEnv = new GitEnv({
		cyrusHome: join(root, "home"),
		allowFileProtocol: true,
	});
	const target: GitSessionTarget = {
		repositoryId: "repo-1",
		repositoryPath: repo,
		workspacePath: ws,
		branchName: branch,
	};
	const sessionGit = new SessionGit(gitEnv, [target]);
	return {
		root,
		repo,
		ws,
		branch,
		remote,
		gitEnv,
		sessionGit,
		target,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

// Real git, no mocks: a temp bare "origin", a clone, and a seeding clone.
const BRANCH = "cyrustester/eng-97-fix-shader";

const git = (cwd: string, cmd: string): string =>
	execSync(`git ${cmd}`, {
		cwd,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	})
		.toString()
		.trim();

describe("GitService.createGitWorktree with a real remote branch", () => {
	let root: string;
	let origin: string;
	let repo: string; // the repository Cyrus manages
	let other: string; // a second clone used to push to origin
	let worktrees: string;
	let service: GitService;
	const logger: any = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};

	const commit = (cwd: string, file: string) => {
		writeFileSync(join(cwd, file), file);
		git(cwd, "add -A");
		git(cwd, `commit -q -m ${file}`);
	};
	const issue: any = {
		id: "issue-1",
		identifier: "ENG-97",
		title: "Fix the shader",
		branchName: BRANCH,
		labels: () => Promise.resolve({ nodes: [] }),
		parent: Promise.resolve(undefined),
		inverseRelations: () => Promise.resolve({ nodes: [] }),
	};
	const repository = (): any => ({
		id: "repo-1",
		name: "r",
		repositoryPath: repo,
		workspaceBaseDir: worktrees,
		baseBranch: "main",
	});
	const create = () => service.createGitWorktree(issue, [repository()]);

	const savedEnv: Record<string, string | undefined> = {};
	const ENV = {
		GIT_CONFIG_GLOBAL: "/dev/null", // do not inherit e.g. fetch.prune=true
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
	};

	beforeEach(() => {
		for (const [k, v] of Object.entries(ENV)) {
			savedEnv[k] = process.env[k];
			process.env[k] = v;
		}
		root = realpathSync(mkdtempSync(join(tmpdir(), "cyrus-git-it-")));
		origin = join(root, "origin.git");
		repo = join(root, "repo");
		other = join(root, "other");
		worktrees = join(root, "worktrees");
		git(root, `init -q --bare -b main "${origin}"`);
		git(root, `clone -q "${origin}" "${repo}"`);
		git(repo, "checkout -q -b main");
		commit(repo, "a.txt");
		git(repo, "push -q origin main");
		git(root, `clone -q "${origin}" "${other}"`);
		vi.clearAllMocks();
		// The fixture remote is a local path: allow the file protocol (tests only).
		service = new GitService(
			{ cyrusHome: join(root, "home"), gitAllowFileProtocol: true },
			logger,
		);
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const pushRemoteBranch = (n: number) => {
		git(other, "fetch -q origin");
		git(other, `checkout -q -B ${BRANCH} origin/main`);
		for (let i = 0; i < n; i++) commit(other, `remote${i}.txt`);
		git(other, `push -q origin ${BRANCH}`);
	};
	const wsPath = () => join(worktrees, "ENG-97");

	it("remote-only branch: worktree continues from origin/<branch> and tracks it", async () => {
		pushRemoteBranch(1);
		const remoteSha = git(other, "rev-parse HEAD");
		const ws = await create();
		expect(ws.isGitWorktree).toBe(true);
		expect(git(wsPath(), "rev-parse HEAD")).toBe(remoteSha);
		expect(existsSync(join(wsPath(), "remote0.txt"))).toBe(true);
		expect(git(wsPath(), "rev-parse --abbrev-ref @{u}")).toBe(
			`origin/${BRANCH}`,
		);
	});

	it("local branch behind remote is fast-forwarded", async () => {
		pushRemoteBranch(1);
		git(repo, `branch ${BRANCH} origin/main`); // stale local copy
		const staleSha = git(repo, `rev-parse ${BRANCH}`);
		git(repo, "fetch -q origin");
		const remoteSha = git(other, "rev-parse HEAD");
		expect(staleSha).not.toBe(remoteSha);
		await create();
		expect(git(wsPath(), "rev-parse HEAD")).toBe(remoteSha);
		expect(git(repo, `rev-parse ${BRANCH}`)).toBe(remoteSha);
	});

	it("diverged local branch keeps its commits and warns", async () => {
		pushRemoteBranch(1);
		git(repo, `branch ${BRANCH} origin/main`);
		git(repo, `checkout -q ${BRANCH}`);
		commit(repo, "local-only.txt");
		const localSha = git(repo, "rev-parse HEAD");
		git(repo, "checkout -q main");
		await create();
		expect(git(wsPath(), "rev-parse HEAD")).toBe(localSha);
		expect(existsSync(join(wsPath(), "local-only.txt"))).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("diverged"),
		);
	});

	it("a remote branch deleted after merge is not treated as existing", async () => {
		pushRemoteBranch(1);
		git(repo, "fetch -q origin"); // repo now has a stale origin/<branch> ref
		git(other, `push -q origin --delete ${BRANCH}`);
		await create();
		// Fresh branch from origin/main, not from the deleted remote branch
		expect(git(wsPath(), "rev-parse HEAD")).toBe(
			git(repo, "rev-parse origin/main"),
		);
		expect(existsSync(join(wsPath(), "remote0.txt"))).toBe(false);
	});

	it("no remote branch: unchanged, branches from origin/main", async () => {
		await create();
		expect(git(wsPath(), "rev-parse HEAD")).toBe(
			git(repo, "rev-parse origin/main"),
		);
	});
});

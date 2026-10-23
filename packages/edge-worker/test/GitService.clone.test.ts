import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import { GitEnv, GitEnvError } from "../src/gitEnv.js";
import { git, makeSessionFixture } from "./helpers/sessionGitFixture.js";

const logger = (): ILogger &
	Record<"warn" | "info", ReturnType<typeof vi.fn>> =>
	({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}) as never;

const issue = (identifier = "ENG-1", branchName = "eng-1-work") =>
	({ id: `id-${identifier}`, identifier, title: "work", branchName }) as never;

interface Fx {
	root: string;
	source: string;
	remote: string;
	worktrees: string;
	repo: RepositoryConfig;
	service: GitService;
	log: ReturnType<typeof logger>;
	ws: (id?: string) => string;
	cleanup(): void;
}

function makeFx(opts: { remote?: boolean; allowFile?: boolean } = {}): Fx {
	// Reuse the session fixture only for its tmp root + source repo + remote.
	const base = makeSessionFixture({ remote: opts.remote ?? true });
	// The fixture leaves a linked worktree on main; drop it so the source is a
	// plain checkout like ~/repos/<name>.
	git(base.repo, "worktree", "remove", "--force", base.ws);
	git(base.repo, "checkout", "main");
	// Where deleteWorkspace looks: <cyrusHome>/worktrees.
	const worktrees = join(base.root, "home", "worktrees");
	const log = logger();
	const repo = {
		id: "repo-1",
		name: "repo",
		repositoryPath: base.repo,
		workspaceBaseDir: worktrees,
		baseBranch: "main",
	} as unknown as RepositoryConfig;
	const service = new GitService(
		{
			cyrusHome: join(base.root, "home"),
			gitAllowFileProtocol: opts.allowFile ?? true,
			cloneMinFreeBytes: 0,
		},
		log,
	);
	return {
		root: base.root,
		source: base.repo,
		remote: base.remote ?? "",
		worktrees,
		repo,
		service,
		log,
		ws: (id = "ENG-1") => join(worktrees, id),
		cleanup: base.cleanup,
	};
}

/** What a session sees: plain git, no GIT_* pins, own hooks and config. */
const sessionGit = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();

describe("clone per session", () => {
	let fx: Fx;
	beforeEach(() => {
		fx = makeFx();
	});
	afterEach(() => fx.cleanup());

	it("makes a standalone clone: own .git directory, no pointers, no shared objects", async () => {
		const ws = await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(ws.isGitWorktree).toBe(true);
		expect(ws.path).toBe(fx.ws());
		expect(ws.branchNames).toEqual({ "repo-1": "eng-1-work" });
		expect(lstatSync(join(fx.ws(), ".git")).isDirectory()).toBe(true);
		expect(existsSync(join(fx.ws(), ".git", "commondir"))).toBe(false);
		expect(
			existsSync(join(fx.ws(), ".git", "objects", "info", "alternates")),
		).toBe(false);
		expect(sessionGit(fx.ws(), "branch", "--show-current")).toBe("eng-1-work");
		expect(readFileSync(join(fx.ws(), "README.md"), "utf8")).toBe("hello\n");
		// --no-hardlinks: no object file shares an inode with the source.
		const objects = join(fx.ws(), ".git", "objects");
		const files: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(d, e.name));
				else files.push(join(d, e.name));
			}
		};
		walk(objects);
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) expect(lstatSync(f).nlink).toBe(1);
	});

	it("leaves the source repository byte-identical and never runs a worktree command", async () => {
		const snapshot = () => ({
			config: readFileSync(join(fx.source, ".git", "config"), "utf8"),
			refs: git(fx.source, "for-each-ref"),
			worktrees: existsSync(join(fx.source, ".git", "worktrees")),
			head: readFileSync(join(fx.source, ".git", "HEAD"), "utf8"),
		});
		const before = snapshot();
		const calls: string[][] = [];
		const run = fx.service.gitEnv.run.bind(fx.service.gitEnv);
		vi.spyOn(fx.service.gitEnv, "run").mockImplementation((inv, args, o) => {
			calls.push(args);
			return run(inv, args, o);
		});
		await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(snapshot()).toEqual(before);
		expect(calls.some((a) => a.includes("worktree"))).toBe(false);
		expect(calls.some((a) => a.includes("prune"))).toBe(false);
	});

	it("passes --no-hardlinks and protocol.file.allow=always on the clone call only", async () => {
		const plain = new GitService(
			{ cyrusHome: join(fx.root, "home2"), cloneMinFreeBytes: 0 },
			fx.log,
		);
		const calls: string[][] = [];
		const run = plain.gitEnv.run.bind(plain.gitEnv);
		vi.spyOn(plain.gitEnv, "run").mockImplementation((inv, args, o) => {
			calls.push(args);
			return run(inv, args, o);
		});
		const ws = await plain.createGitWorktree(issue(), [fx.repo]);
		expect(ws.isGitWorktree).toBe(true);
		const withFile = calls.filter((a) =>
			a.includes("protocol.file.allow=always"),
		);
		// The clone itself, and the update of its remote-tracking refs from the
		// LOCAL source: nothing else ever allows the file protocol.
		expect(
			withFile.map((a) => a.find((x) => ["clone", "fetch"].includes(x))),
		).toEqual(["clone", "fetch"]);
		expect(withFile[0]).toContain("--no-hardlinks");
		expect(withFile[1]).toContain(realpathSync.native(fx.source));
		// and the pinned env itself never allows the file protocol
		const env = new GitEnv({ cyrusHome: join(fx.root, "h3") }).plainScope(
			fx.root,
		).env;
		const keys = Array.from(
			{ length: Number(env.GIT_CONFIG_COUNT) },
			(_, i) => env[`GIT_CONFIG_KEY_${i}`],
		);
		expect(keys).not.toContain("protocol.file.allow");
		expect(env[`GIT_CONFIG_VALUE_${keys.indexOf("protocol.allow")}`]).toBe(
			"never",
		);
	});

	it("starts a new branch from the remote default and tracks its own name", async () => {
		await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(sessionGit(fx.ws(), "rev-parse", "HEAD")).toBe(
			git(fx.source, "rev-parse", "main").trim(),
		);
		const cfg = readFileSync(join(fx.ws(), ".git", "config"), "utf8");
		expect(cfg).toContain('[branch "eng-1-work"]');
		expect(cfg).toContain('merge = "refs/heads/eng-1-work"');
		expect(cfg).toContain(fx.remote);
	});

	it("fetch failure still clones from the source refs", async () => {
		const gone = join(fx.root, "gone.git");
		git(fx.source, "remote", "set-url", "origin", gone);
		const ws = await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(ws.isGitWorktree).toBe(true);
		expect(fx.log.warn).toHaveBeenCalled();
		expect(sessionGit(fx.ws(), "branch", "--show-current")).toBe("eng-1-work");
	});

	it("refuses to clone below the free-space guard and flags the repo", async () => {
		const guarded = new GitService(
			{
				cyrusHome: join(fx.root, "home"),
				gitAllowFileProtocol: true,
				cloneMinFreeBytes: Number.MAX_SAFE_INTEGER,
			},
			fx.log,
		);
		const ws = await guarded.createGitWorktree(issue(), [fx.repo]);
		expect(ws.isGitWorktree).toBe(false);
		expect(ws.cloneFailed).toEqual(["repo-1"]);
		expect(existsSync(join(fx.ws(), ".git"))).toBe(false);
	});

	it("multi-repo: one clone per repo; a failed clone is flagged and gets no git", async () => {
		const bad = {
			...fx.repo,
			id: "repo-2",
			name: "broken",
			repositoryPath: join(fx.root, "not-a-repo"),
		} as RepositoryConfig;
		mkdirSync(bad.repositoryPath);
		const second = makeFx();
		const good2 = {
			...second.repo,
			id: "repo-3",
			name: "other",
			workspaceBaseDir: fx.worktrees,
		} as RepositoryConfig;
		try {
			const ws = await fx.service.createGitWorktree(issue(), [
				fx.repo,
				bad,
				good2,
			]);
			expect(ws.path).toBe(fx.ws());
			expect(ws.repoPaths).toEqual({
				"repo-1": join(fx.ws(), "repo"),
				"repo-2": join(fx.ws(), "broken"),
				"repo-3": join(fx.ws(), "other"),
			});
			expect(ws.cloneFailed).toEqual(["repo-2"]);
			expect(lstatSync(join(fx.ws(), "repo", ".git")).isDirectory()).toBe(true);
			expect(lstatSync(join(fx.ws(), "other", ".git")).isDirectory()).toBe(
				true,
			);
			expect(existsSync(join(fx.ws(), "broken", ".git"))).toBe(false);
			expect(ws.branchNames).toHaveProperty("repo-1");
		} finally {
			second.cleanup();
		}
	});

	it("deleteWorkspace removes the directory, runs teardown once, and runs no git", async () => {
		await fx.service.createGitWorktree(issue(), [fx.repo]);
		const teardown = join(fx.ws(), "cyrus-teardown.sh");
		writeFileSync(
			teardown,
			`#!/bin/sh\necho "$LINEAR_ISSUE_IDENTIFIER" >> "${fx.root}/teardown-ran"\n`,
		);
		chmodSync(teardown, 0o755);
		const spy = vi.spyOn(fx.service.gitEnv, "run");
		await fx.service.deleteWorkspace("ENG-1", { repositories: [fx.repo] });
		expect(existsSync(fx.ws())).toBe(false);
		expect(readFileSync(join(fx.root, "teardown-ran"), "utf8")).toBe("ENG-1\n");
		expect(spy).not.toHaveBeenCalled();
		// the deprecated name still works
		await fx.service.deleteWorktree("ENG-1");
	});
});

describe("optional shallow clones (cloneDepth)", () => {
	let fx: Fx;
	const commits = (cwd: string) =>
		Number(sessionGit(cwd, "rev-list", "--count", "HEAD"));
	const pushHistory = (n: number) => {
		for (let i = 0; i < n; i++) {
			writeFileSync(join(fx.source, `h${i}.txt`), `${i}\n`);
			git(fx.source, "add", `h${i}.txt`);
			git(fx.source, "commit", "-m", `h${i}`);
		}
		git(fx.source, "push", "-q", "origin", "main");
	};
	beforeEach(() => {
		fx = makeFx();
		pushHistory(3);
	});
	afterEach(() => fx.cleanup());

	it("default (no cloneDepth): full history, not shallow", async () => {
		await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(commits(fx.ws())).toBe(4);
		expect(sessionGit(fx.ws(), "rev-parse", "--is-shallow-repository")).toBe(
			"false",
		);
	});

	it("cloneDepth=1 gives a shallow clone via file:// that still gets its session branch", async () => {
		const calls: string[][] = [];
		const run = fx.service.gitEnv.run.bind(fx.service.gitEnv);
		vi.spyOn(fx.service.gitEnv, "run").mockImplementation((inv, args, o) => {
			calls.push(args);
			return run(inv, args, o);
		});
		const repo = { ...fx.repo, cloneDepth: 1 } as RepositoryConfig;
		const ws = await fx.service.createGitWorktree(issue(), [repo]);
		expect(ws.isGitWorktree).toBe(true);
		expect(commits(fx.ws())).toBe(1);
		expect(sessionGit(fx.ws(), "rev-parse", "--is-shallow-repository")).toBe(
			"true",
		);
		expect(sessionGit(fx.ws(), "branch", "--show-current")).toBe("eng-1-work");
		const clone = calls.find((a) => a.includes("clone")) as string[];
		expect(clone).toContain("--depth");
		expect(clone.some((a) => a.startsWith("file://"))).toBe(true);
		// the update from the local source keeps the depth (file:// form)
		const local = calls.find(
			(a) => a.includes("fetch") && a.includes("protocol.file.allow=always"),
		) as string[];
		expect(local).toContain("--depth");
		expect(local.some((x) => x.startsWith("file://"))).toBe(true);
		// GitHub is only ever fetched in repo scope, without a depth
		const github = calls.find((a) => a[0] === "fetch") as string[];
		expect(github).not.toContain("--depth");
	});

	it("never turns an existing full clone shallow on reuse (--depth only for shallow clones)", async () => {
		await fx.service.createGitWorktree(issue(), [fx.repo]); // full clone
		const calls: string[][] = [];
		const run = fx.service.gitEnv.run.bind(fx.service.gitEnv);
		vi.spyOn(fx.service.gitEnv, "run").mockImplementation((inv, args, o) => {
			calls.push(args);
			return run(inv, args, o);
		});
		const repo = { ...fx.repo, cloneDepth: 1 } as RepositoryConfig;
		await fx.service.createGitWorktree(issue(), [repo]);
		expect(calls.some((a) => a.includes("--depth"))).toBe(false);
		expect(sessionGit(fx.ws(), "rev-parse", "--is-shallow-repository")).toBe(
			"false",
		);
	});

	it("a PR session can check out an existing remote branch on a shallow clone", async () => {
		const other = join(fx.root, "other");
		git(fx.root, "clone", "-q", fx.remote, other);
		git(other, "checkout", "-q", "-b", "pr-branch");
		for (let i = 0; i < 3; i++) {
			writeFileSync(join(other, `pr${i}.txt`), "p\n");
			git(other, "add", `pr${i}.txt`);
			git(other, "commit", "-m", `pr${i}`);
		}
		git(other, "push", "-q", "origin", "pr-branch");
		const repo = { ...fx.repo, cloneDepth: 1 } as RepositoryConfig;
		await fx.service.createGitWorktree(issue("repo-PR-5", "pr-branch"), [repo]);
		const ws = fx.ws("repo-PR-5");
		expect(sessionGit(ws, "branch", "--show-current")).toBe("pr-branch");
		expect(existsSync(join(ws, "pr2.txt"))).toBe(true);
		expect(commits(ws)).toBe(1);
		// reusing it (follow-up comment) keeps working and stays shallow
		await fx.service.createGitWorktree(issue("repo-PR-5", "pr-branch"), [repo]);
		expect(sessionGit(ws, "rev-parse", "--is-shallow-repository")).toBe("true");
		expect(sessionGit(ws, "branch", "--show-current")).toBe("pr-branch");
	});
});

describe("reuse, shape check and re-stamp", () => {
	let fx: Fx;
	beforeEach(async () => {
		fx = makeFx();
		await fx.service.createGitWorktree(issue(), [fx.repo]);
	});
	afterEach(() => fx.cleanup());

	const again = () => fx.service.createGitWorktree(issue(), [fx.repo]);
	const asideDirs = () =>
		readdirSync(fx.worktrees).filter((n) =>
			/\.(quarantine|worktree-old)-/.test(n),
		);

	it("reuses a healthy clone and keeps the session's committed work", async () => {
		writeFileSync(join(fx.ws(), "work.txt"), "mine\n");
		sessionGit(fx.ws(), "add", "work.txt");
		sessionGit(fx.ws(), "commit", "-m", "work");
		const head = sessionGit(fx.ws(), "rev-parse", "HEAD");
		const ws = await again();
		expect(ws.isGitWorktree).toBe(true);
		expect(sessionGit(fx.ws(), "rev-parse", "HEAD")).toBe(head);
		expect(asideDirs()).toEqual([]);
	});

	it("re-stamps a mismatched origin without deleting work, and strips planted keys", async () => {
		writeFileSync(join(fx.ws(), "work.txt"), "mine\n");
		sessionGit(fx.ws(), "add", "work.txt");
		sessionGit(fx.ws(), "commit", "-m", "work");
		const planted = join(fx.ws(), ".git", "config");
		writeFileSync(
			planted,
			`${readFileSync(planted, "utf8")}[core]\n\tfsmonitor = /tmp/evil\n[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n[remote "origin"]\n\turl = https://evil.example/x.git\n`,
		);
		await again();
		const cfg = readFileSync(planted, "utf8");
		expect(cfg).not.toContain("evil");
		expect(cfg).not.toContain("fsmonitor");
		expect(cfg).toContain(fx.remote);
		expect(readFileSync(join(fx.ws(), "work.txt"), "utf8")).toBe("mine\n");
		expect(asideDirs()).toEqual([]);
	});

	it("keeps only user.name, user.email and a relative core.hooksPath", async () => {
		const cfg = join(fx.ws(), ".git", "config");
		sessionGit(fx.ws(), "config", "user.name", "Session Bot");
		sessionGit(fx.ws(), "config", "user.email", "bot@example.test");
		sessionGit(fx.ws(), "config", "core.hooksPath", ".husky");
		sessionGit(fx.ws(), "config", "core.sshCommand", "/tmp/evil");
		await again();
		expect(sessionGit(fx.ws(), "config", "user.name")).toBe("Session Bot");
		expect(sessionGit(fx.ws(), "config", "user.email")).toBe(
			"bot@example.test",
		);
		expect(sessionGit(fx.ws(), "config", "core.hooksPath")).toBe(".husky");
		expect(readFileSync(cfg, "utf8")).not.toContain("sshCommand");
		for (const bad of ["/abs/hooks", "../escape", ".husky/../../x"]) {
			sessionGit(fx.ws(), "config", "core.hooksPath", bad);
			await again();
			expect(readFileSync(cfg, "utf8")).not.toContain("hooksPath");
		}
	});

	it("fetches GitHub in repo scope only, then updates the clone from the local source", async () => {
		const evilUrl = join(fx.root, "evil-remote.git");
		const cfg = join(fx.ws(), ".git", "config");
		writeFileSync(
			cfg,
			`${readFileSync(cfg, "utf8")}[remote "origin"]\n\turl = ${evilUrl}\n`,
		);
		const calls: Array<{ gitDir: string | undefined; args: string[] }> = [];
		const run = fx.service.gitEnv.run.bind(fx.service.gitEnv);
		vi.spyOn(fx.service.gitEnv, "run").mockImplementation((inv, args, o) => {
			calls.push({ gitDir: inv.env.GIT_DIR, args });
			return run(inv, args, o);
		});
		await again();
		const fetches = calls.filter((c) => c.args.includes("fetch"));
		expect(fetches).toHaveLength(2);
		const [github, local] = fetches as [
			(typeof fetches)[number],
			(typeof fetches)[number],
		];
		// GitHub: the source repo's .git, explicit trusted URL + refspec
		expect(github.gitDir).toBe(join(realpathSync.native(fx.source), ".git"));
		expect(github.args).toEqual([
			"fetch",
			"--prune",
			"--",
			fx.remote,
			"+refs/heads/*:refs/remotes/origin/*",
		]);
		// Clone: only from the local source, only remote-tracking refs
		expect(local.gitDir).toBe(join(realpathSync.native(fx.ws()), ".git"));
		expect(local.args.slice(-2)).toEqual([
			realpathSync.native(fx.source),
			"+refs/remotes/origin/*:refs/remotes/origin/*",
		]);
		expect(JSON.stringify(calls)).not.toContain("evil-remote");
	});

	it("no fetch in the clone's scope ever carries a network URL, whatever the session planted", async () => {
		git(
			fx.source,
			"remote",
			"set-url",
			"origin",
			"https://github.com/acme/widgets.git",
		);
		const cfg = join(fx.ws(), ".git", "config");
		writeFileSync(
			cfg,
			`${readFileSync(cfg, "utf8")}[http "https://github.com/"]\n\tproxy = http://127.0.0.1:1\n\tsslVerify = false\n`,
		);
		const cloneGitDir = join(realpathSync.native(fx.ws()), ".git");
		const cloneCalls: string[][] = [];
		const run = fx.service.gitEnv.run.bind(fx.service.gitEnv);
		vi.spyOn(fx.service.gitEnv, "run").mockImplementation((inv, args, o) => {
			if (inv.env.GIT_DIR === cloneGitDir) cloneCalls.push(args);
			return run(inv, args, o);
		});
		await again();
		expect(cloneCalls.length).toBeGreaterThan(0);
		for (const args of cloneCalls) {
			expect(args.some((a) => /^(https?|ssh|git):\/\//.test(a))).toBe(false);
		}
		// and the re-stamp removed the planted keys
		const stamped = readFileSync(cfg, "utf8");
		expect(stamped).not.toContain("proxy");
		expect(stamped).not.toContain("sslVerify");
	});

	it("writes the clone config owner-only (0600)", async () => {
		await again();
		expect(statSync(join(fx.ws(), ".git", "config")).mode & 0o777).toBe(0o600);
	});

	it("fast-forwards a clean clone that is strictly behind its remote branch", async () => {
		const other = join(fx.root, "other");
		git(fx.root, "clone", "-q", fx.remote, other);
		git(other, "checkout", "-q", "-b", "eng-1-work");
		writeFileSync(join(other, "remote.txt"), "r\n");
		git(other, "add", "remote.txt");
		git(other, "commit", "-m", "remote");
		git(other, "push", "-q", "origin", "eng-1-work");
		await again();
		expect(existsSync(join(fx.ws(), "remote.txt"))).toBe(true);
		// dirty tree: left alone
		writeFileSync(join(fx.ws(), "README.md"), "dirty\n");
		git(other, "commit", "--allow-empty", "-m", "more");
		git(other, "push", "-q", "origin", "eng-1-work");
		const head = sessionGit(fx.ws(), "rev-parse", "HEAD");
		await again();
		expect(sessionGit(fx.ws(), "rev-parse", "HEAD")).toBe(head);
	});

	describe.each([
		[
			"a commondir file",
			(g: string) => writeFileSync(join(g, "commondir"), "/elsewhere\n"),
		],
		[
			"objects/info/alternates",
			(g: string) => {
				mkdirSync(join(g, "objects", "info"), { recursive: true });
				writeFileSync(join(g, "objects", "info", "alternates"), "/elsewhere\n");
			},
		],
		[
			"a garbage HEAD",
			(g: string) => writeFileSync(join(g, "HEAD"), "not a ref\n"),
		],
		[
			"a symlinked hooks dir",
			(g: string) => {
				rmSync(join(g, "hooks"), { recursive: true, force: true });
				symlinkSync("/tmp", join(g, "hooks"));
			},
		],
		[
			"a symlinked objects/pack",
			(g: string) => {
				const target = join(g, "..", "..", "pack-elsewhere");
				mkdirSync(target);
				writeFileSync(join(target, "keep.txt"), "untouched\n");
				rmSync(join(g, "objects", "pack"), { recursive: true, force: true });
				symlinkSync(target, join(g, "objects", "pack"));
			},
		],
		[
			"a symlinked refs/remotes",
			(g: string) => {
				const target = join(g, "..", "..", "refs-elsewhere");
				mkdirSync(target);
				writeFileSync(join(target, "keep.txt"), "untouched\n");
				rmSync(join(g, "refs", "remotes"), { recursive: true, force: true });
				symlinkSync(target, join(g, "refs", "remotes"));
			},
		],
		[
			"a symlinked file deep under logs",
			(g: string) => {
				mkdirSync(join(g, "logs", "refs"), { recursive: true });
				writeFileSync(join(g, "..", "..", "log-target"), "x\n");
				symlinkSync(
					join(g, "..", "..", "log-target"),
					join(g, "logs", "refs", "heads-link"),
				);
			},
		],
		[
			"a symlinked config",
			(g: string) => {
				const target = join(g, "..", "..", "real-config");
				writeFileSync(target, "[core]\n\tfsmonitor = /tmp/evil\n");
				rmSync(join(g, "config"));
				symlinkSync(target, join(g, "config"));
			},
		],
	])("shape check rejects %s", (_name, plant) => {
		it("moves the clone aside untouched and clones fresh", async () => {
			const gitDir = join(fx.ws(), ".git");
			writeFileSync(join(fx.ws(), "marker.txt"), "session file\n");
			plant(gitDir);
			expect(() => fx.service.gitEnv.assertCloneShape(fx.ws())).toThrow(
				GitEnvError,
			);
			const ws = await again();
			expect(ws.isGitWorktree).toBe(true);
			const aside = asideDirs();
			expect(aside).toHaveLength(1);
			expect(
				readFileSync(
					join(fx.worktrees, aside[0] as string, "marker.txt"),
					"utf8",
				),
			).toBe("session file\n");
			expect(existsSync(join(fx.ws(), "marker.txt"))).toBe(false);
			fx.service.gitEnv.assertCloneShape(fx.ws()); // the new one is healthy
		});
	});

	it("a symlinked .git is rejected too", async () => {
		const real = join(fx.root, "real-git");
		rmSync(join(fx.ws(), ".git"), { recursive: true, force: true });
		mkdirSync(real);
		symlinkSync(real, join(fx.ws(), ".git"));
		expect(() => fx.service.gitEnv.assertCloneShape(fx.ws())).toThrow(
			/not a real directory/,
		);
	});

	it("a legacy linked worktree (.git file) is set aside as .worktree-old and replaced", async () => {
		rmSync(join(fx.ws(), ".git"), { recursive: true, force: true });
		writeFileSync(
			join(fx.ws(), ".git"),
			`gitdir: ${fx.source}/.git/worktrees/x\n`,
		);
		const ws = await again();
		expect(ws.isGitWorktree).toBe(true);
		expect(asideDirs().some((n) => n.includes(".worktree-old-"))).toBe(true);
		fx.service.gitEnv.assertCloneShape(fx.ws());
	});
});

describe("husky-style project hooks keep working in the session", () => {
	let fx: Fx;
	beforeEach(() => {
		fx = makeFx();
	});
	afterEach(() => fx.cleanup());

	it("the session's own commit runs the project hook; the parent's git runs none", async () => {
		const markers = join(fx.root, "hook-markers");
		mkdirSync(markers);
		mkdirSync(join(fx.source, ".husky"));
		for (const h of ["pre-commit", "post-merge", "post-checkout"]) {
			const p = join(fx.source, ".husky", h);
			writeFileSync(p, `#!/bin/sh\necho ran >> "${markers}/${h}"\n`);
			chmodSync(p, 0o755);
		}
		git(fx.source, "add", ".husky");
		git(fx.source, "commit", "-m", "husky");
		git(fx.source, "push", "-q", "origin", "main");

		await fx.service.createGitWorktree(issue(), [fx.repo]);
		// Nothing from the project ran during the parent's clone/checkout.
		expect(readdirSync(markers)).toEqual([]);

		// What `husky install` does in the session.
		sessionGit(fx.ws(), "config", "core.hooksPath", ".husky");
		// The parent re-stamps and fast-forwards (post-merge exists): still none.
		const other = join(fx.root, "other");
		git(fx.root, "clone", "-q", fx.remote, other);
		git(other, "checkout", "-q", "-b", "eng-1-work");
		writeFileSync(join(other, "x.txt"), "x\n");
		git(other, "add", "x.txt");
		git(other, "commit", "-m", "x");
		git(other, "push", "-q", "origin", "eng-1-work");
		await fx.service.createGitWorktree(issue(), [fx.repo]);
		expect(existsSync(join(fx.ws(), "x.txt"))).toBe(true);
		expect(readdirSync(markers)).toEqual([]);

		// The session's own git (no pins in its env) still runs the hook.
		expect(sessionGit(fx.ws(), "config", "core.hooksPath")).toBe(".husky");
		writeFileSync(join(fx.ws(), "y.txt"), "y\n");
		sessionGit(fx.ws(), "add", "y.txt");
		sessionGit(fx.ws(), "commit", "-m", "y");
		expect(readdirSync(markers)).toEqual(["pre-commit"]);
	});
});

describe("sweep and legacy worktree cutover", () => {
	let fx: Fx;
	beforeEach(() => {
		fx = makeFx();
		mkdirSync(fx.worktrees, { recursive: true });
	});
	afterEach(() => fx.cleanup());

	const age = (path: string, days: number) => {
		const t = new Date(Date.now() - days * 86_400_000);
		utimesSync(path, t, t);
	};

	it("removes old PR clones and set-aside dirs, never live, young or issue workspaces", () => {
		const dirs = {
			oldPr: "repo-PR-5",
			youngPr: "repo-PR-6",
			livePr: "repo-PR-7",
			oldAside: "ENG-9.quarantine-1700000000000",
			oldWt: "ENG-8.worktree-old-1700000000000",
			youngAside: "ENG-7.quarantine-1700000000001",
			issue: "ENG-1",
			oldIssue: "ENG-2",
		};
		for (const d of Object.values(dirs)) mkdirSync(join(fx.worktrees, d));
		for (const d of [dirs.oldPr, dirs.livePr, dirs.oldIssue])
			age(join(fx.worktrees, d), 20);
		for (const d of [dirs.oldAside, dirs.oldWt]) age(join(fx.worktrees, d), 8);
		age(join(fx.worktrees, dirs.youngAside), 2);
		const removed = fx.service.sweepWorkspaces({
			baseDirs: [fx.worktrees],
			maxAgeDays: 14,
			isInUse: (p) => p.endsWith(dirs.livePr),
		});
		expect(removed.sort()).toEqual(
			[dirs.oldAside, dirs.oldPr, dirs.oldWt].sort(),
		);
		expect(readdirSync(fx.worktrees).sort()).toEqual(
			[
				dirs.youngPr,
				dirs.livePr,
				dirs.youngAside,
				dirs.issue,
				dirs.oldIssue,
			].sort(),
		);
	});

	const legacy = () => {
		const f = makeSessionFixture();
		return f;
	};

	it("cutover: clean legacy worktrees are set aside, dirty ones stay unless --discard", () => {
		const f = legacy();
		try {
			const svc = new GitService({ cyrusHome: join(f.root, "home") }, logger());
			const repo = { id: "repo-1", name: "r", repositoryPath: f.repo } as never;
			const base = join(f.root, "worktrees");
			// dirty
			writeFileSync(join(f.ws, "README.md"), "dirty\n");
			const dirty = svc.migrateLegacyWorktrees({
				baseDirs: [base],
				repositories: [repo],
			});
			expect(dirty).toEqual({ moved: [], dirty: ["ENG-1"], invalid: [] });
			expect(existsSync(f.ws)).toBe(true);
			const discarded = svc.migrateLegacyWorktrees({
				baseDirs: [base],
				repositories: [repo],
				discard: true,
			});
			expect(discarded.moved).toEqual(["ENG-1"]);
			expect(existsSync(f.ws)).toBe(false);
			expect(
				readdirSync(base).some((n) => n.startsWith("ENG-1.worktree-old-")),
			).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	it("cutover: skips a workspace a session still uses", () => {
		const f = legacy();
		try {
			const svc = new GitService({ cyrusHome: join(f.root, "home") }, logger());
			const res = svc.migrateLegacyWorktrees({
				baseDirs: [join(f.root, "worktrees")],
				repositories: [
					{ id: "repo-1", name: "r", repositoryPath: f.repo } as never,
				],
				isInUse: (p) => p.endsWith("ENG-1"),
			});
			expect(res).toEqual({ moved: [], dirty: [], invalid: [] });
			expect(existsSync(f.ws)).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	it("cutover: a clean legacy worktree is moved aside", () => {
		const f = legacy();
		try {
			const svc = new GitService({ cyrusHome: join(f.root, "home") }, logger());
			const res = svc.migrateLegacyWorktrees({
				baseDirs: [join(f.root, "worktrees")],
				repositories: [
					{ id: "repo-1", name: "r", repositoryPath: f.repo } as never,
				],
			});
			expect(res).toEqual({ moved: ["ENG-1"], dirty: [], invalid: [] });
			// the retired worktree's admin dir is gone (validated name, no git prune)
			expect(existsSync(join(f.repo, ".git", "worktrees", "ENG-1"))).toBe(
				false,
			);
		} finally {
			f.cleanup();
		}
	});

	it("cutover: forged pointers are moved aside unexamined and no git runs there", () => {
		const f = legacy();
		try {
			const markers = join(f.root, "markers");
			mkdirSync(markers);
			const script = join(f.root, "fsmon.sh");
			writeFileSync(
				script,
				`#!/bin/sh\necho ran >> "${markers}/fsmonitor"\nprintf '\\0'\n`,
			);
			chmodSync(script, 0o755);
			const evil = join(f.root, "evil.git");
			git(f.root, "init", "--bare", evil);
			git(evil, "config", "core.bare", "false");
			git(evil, "config", "core.fsmonitor", script);
			writeFileSync(
				join(f.repo, ".git", "worktrees", "ENG-1", "commondir"),
				`${evil}\n`,
			);
			const svc = new GitService({ cyrusHome: join(f.root, "home") }, logger());
			const spy = vi.spyOn(svc.gitEnv, "run");
			const res = svc.migrateLegacyWorktrees({
				baseDirs: [join(f.root, "worktrees")],
				repositories: [
					{ id: "repo-1", name: "r", repositoryPath: f.repo } as never,
				],
			});
			expect(res).toEqual({ moved: ["ENG-1"], dirty: [], invalid: ["ENG-1"] });
			expect(spy).not.toHaveBeenCalled();
			expect(readdirSync(markers)).toEqual([]);
		} finally {
			f.cleanup();
		}
	});

	it("cutover: a gitfile pointing at another repository is invalid", () => {
		const f = legacy();
		try {
			writeFileSync(
				join(f.ws, ".git"),
				`gitdir: ${f.root}/elsewhere/.git/worktrees/ENG-1\n`,
			);
			const svc = new GitService({ cyrusHome: join(f.root, "home") }, logger());
			const res = svc.migrateLegacyWorktrees({
				baseDirs: [join(f.root, "worktrees")],
				repositories: [
					{ id: "repo-1", name: "r", repositoryPath: f.repo } as never,
				],
			});
			expect(res.invalid).toEqual(["ENG-1"]);
		} finally {
			f.cleanup();
		}
	});
});

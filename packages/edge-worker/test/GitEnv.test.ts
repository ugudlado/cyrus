import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import {
	GitEnv,
	GitEnvError,
	isPlainComponent,
	parseGithubSlug,
	validateWorktreeGitdirs,
} from "../src/gitEnv.js";
import {
	git,
	makeSessionFixture,
	type SessionFixture,
} from "./helpers/sessionGitFixture.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: vi.fn(),
	error: () => {},
} as unknown as ILogger;

describe("GitEnv config pins", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cyrus-gitenv-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const pairsOf = (env: Record<string, string>) => {
		const n = Number(env.GIT_CONFIG_COUNT);
		return Array.from(
			{ length: n },
			(_, i) =>
				[env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]] as const,
		);
	};

	it("pins every dangerous key and the env vars, with the credential helper in boat order", () => {
		const hooks = join(root, "hooks");
		const ge = new GitEnv({
			cyrusHome: root,
			hooksDir: hooks,
			credentialHelper: "/usr/local/libexec/cred",
		});
		const fx = makeSessionFixture();
		try {
			const inv = ge.repoScope(fx.repo);
			expect(pairsOf(inv.env)).toEqual([
				["core.hooksPath", hooks],
				["core.fsmonitor", "false"],
				["credential.helper", ""],
				["credential.https://github.com.helper", ""],
				["credential.https://github.com.helper", "/usr/local/libexec/cred"],
				["core.sshCommand", "/bin/false"],
				["core.gitProxy", ""],
				["http.proxy", ""],
				["protocol.allow", "never"],
				["protocol.https.allow", "always"],
				["gc.auto", "0"],
				["maintenance.auto", "false"],
				["fetch.recurseSubmodules", "false"],
				["merge.verifySignatures", "false"],
				["gpg.program", "/bin/false"],
			]);
			expect(inv.env).toMatchObject({
				GIT_SSH_COMMAND: "/bin/false",
				GIT_ASKPASS: "/bin/false",
				SSH_ASKPASS: "/bin/false",
				GIT_PAGER: "cat",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_REPLACE_OBJECTS: "1",
			});
		} finally {
			fx.cleanup();
		}
	});

	it("leaves credential config alone when no helper is configured, and only adds file:// for tests", () => {
		const fx = makeSessionFixture();
		try {
			const plain = new GitEnv({ cyrusHome: root }).repoScope(fx.repo);
			expect(
				pairsOf(plain.env).some(([k]) => k.startsWith("credential.")),
			).toBe(false);
			expect(
				pairsOf(plain.env).some(([k]) => k === "protocol.file.allow"),
			).toBe(false);
		} finally {
			fx.cleanup();
		}
	});

	it("does not inherit the process env wholesale", () => {
		const fx = makeSessionFixture();
		process.env.GITHUB_TOKEN = "ghs_should_not_leak";
		process.env.GIT_SSL_CAINFO = "/nope";
		try {
			const inv = new GitEnv({ cyrusHome: root }).repoScope(fx.repo);
			expect(JSON.stringify(inv.env)).not.toContain("ghs_should_not_leak");
			expect(inv.env.GIT_SSL_CAINFO).toBeUndefined();
		} finally {
			delete process.env.GITHUB_TOKEN;
			delete process.env.GIT_SSL_CAINFO;
			fx.cleanup();
		}
	});

	it("creates an empty hooks dir by default and refuses a non-empty one on every use", () => {
		const fx = makeSessionFixture();
		try {
			const ge = new GitEnv({ cyrusHome: root });
			ge.repoScope(fx.repo);
			const hooks = join(root, "no-hooks");
			writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n");
			expect(() => ge.repoScope(fx.repo)).toThrow(/not empty/);
		} finally {
			fx.cleanup();
		}
	});

	it("repo scope pins GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE from the configured path", () => {
		const fx = makeSessionFixture();
		try {
			const inv = new GitEnv({ cyrusHome: root }).repoScope(fx.repo);
			expect(inv.env.GIT_DIR).toBe(inv.env.GIT_COMMON_DIR);
			expect(inv.env.GIT_DIR?.endsWith("/.git")).toBe(true);
			expect(inv.cwd).toBe(inv.env.GIT_WORK_TREE);
		} finally {
			fx.cleanup();
		}
	});

	it("throws for a path with no .git directory", () => {
		expect(() =>
			new GitEnv({ cyrusHome: root }).repoScope(join(root, "nothing")),
		).toThrow(GitEnvError);
	});
});

describe("GitEnv session scope and admin names", () => {
	let fx: SessionFixture;
	beforeEach(() => {
		fx = makeSessionFixture();
	});
	afterEach(() => fx.cleanup());

	it("resolves the admin dir by exact gitdir match and pins it", () => {
		const name = fx.gitEnv.resolveAdminName(fx.repo, fx.ws);
		expect(name).toBe("ENG-1");
		const inv = fx.gitEnv.sessionScope({ ...fx.target, adminName: name ?? "" });
		expect(inv.env.GIT_DIR?.endsWith("/.git/worktrees/ENG-1")).toBe(true);
		expect(inv.env.GIT_COMMON_DIR?.endsWith("/.git")).toBe(true);
		expect(inv.env.GIT_WORK_TREE).toContain("ENG-1");
	});

	it("never guesses from the basename: no match or two matches is null", () => {
		expect(
			fx.gitEnv.resolveAdminName(fx.repo, join(fx.root, "other")),
		).toBeNull();
		// A second admin dir claiming the same worktree makes the answer ambiguous.
		const dup = join(fx.repo, ".git", "worktrees", "dup");
		mkdirSync(dup);
		writeFileSync(
			join(dup, "gitdir"),
			`${join(realpathSync.native(fx.ws), ".git")}\n`,
		);
		expect(fx.gitEnv.resolveAdminName(fx.repo, fx.ws)).toBeNull();
		expect(() => fx.gitEnv.sessionScope(fx.target)).toThrow(
			/none or ambiguous/,
		);
	});

	it("rejects admin names that are not plain components or not real directories", () => {
		for (const bad of ["..", "a/b", "../x", "."]) {
			expect(isPlainComponent(bad)).toBe(false);
			expect(() =>
				fx.gitEnv.sessionScope({ ...fx.target, adminName: bad }),
			).toThrow(GitEnvError);
		}
		const link = join(fx.repo, ".git", "worktrees", "linked");
		symlinkSync(fx.root, link);
		expect(() =>
			fx.gitEnv.sessionScope({ ...fx.target, adminName: "linked" }),
		).toThrow(/real directory/);
	});

	it("GitService records the admin name at worktree-add time", async () => {
		const service = new GitService(
			{ cyrusHome: join(fx.root, "home"), gitAllowFileProtocol: true },
			silentLogger,
		);
		const ws2 = await service.createGitWorktree(
			{
				id: "i2",
				identifier: "ENG-2",
				title: "two",
				branchName: "eng-2-two",
			} as never,
			[
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: fx.repo,
					workspaceBaseDir: join(fx.root, "worktrees"),
					baseBranch: "main",
				} as never,
			],
		);
		expect(ws2.isGitWorktree).toBe(true);
		expect(ws2.gitDirNames).toEqual({ "repo-1": "ENG-2" });
	});
});

describe("recorded branch name", () => {
	it("records the sanitized branch actually created, not the raw Linear name", async () => {
		const fx = makeSessionFixture();
		try {
			const service = new GitService(
				{ cyrusHome: join(fx.root, "home") },
				silentLogger,
			);
			const repo = {
				id: "repo-1",
				name: "repo",
				repositoryPath: fx.repo,
				workspaceBaseDir: join(fx.root, "worktrees"),
				baseBranch: "main",
			} as never;
			const ws = await service.createGitWorktree(
				{
					id: "i4",
					identifier: "ENG-4",
					title: "t",
					branchName: "eng-4: fix thing~1",
				} as never,
				[repo],
			);
			expect(ws.branchNames).toEqual({ "repo-1": "eng-4-fix-thing-1" });
			expect(git(ws.path, "branch", "--show-current").trim()).toBe(
				"eng-4-fix-thing-1",
			);
			// A generated name (no Linear branch) is recorded as generated.
			const gen = await service.createGitWorktree(
				{ id: "i5", identifier: "ENG-5", title: "Some Title" } as never,
				[repo],
			);
			expect(gen.branchNames?.["repo-1"]).toBe("ENG-5-some-title");
		} finally {
			fx.cleanup();
		}
	});
});

describe("worktree gitdir validation (repair/prune gate)", () => {
	let fx: SessionFixture;
	let worktrees: string;
	let common: string;
	beforeEach(() => {
		fx = makeSessionFixture();
		worktrees = join(fx.root, "worktrees");
		common = join(fx.repo, ".git");
	});
	afterEach(() => fx.cleanup());

	it("passes a valid layout", () => {
		expect(validateWorktreeGitdirs(common, worktrees)).toEqual({
			ok: true,
			invalid: [],
		});
	});

	it("flags a forged gitdir pointing outside the root (repair would write a gitfile there)", () => {
		const target = join(fx.root, "target");
		mkdirSync(target);
		writeFileSync(
			join(common, "worktrees", "ENG-1", "gitdir"),
			`${target}/.git\n`,
		);
		const res = validateWorktreeGitdirs(common, worktrees);
		expect(res.ok).toBe(false);
		expect(res.invalid).toEqual(["ENG-1"]);
		expect(
			readFileSync(join(common, "worktrees", "ENG-1", "gitdir"), "utf8"),
		).toContain("target");
	});

	it("flags traversal, a symlink escape, and a non-directory entry; names only the bad ones", () => {
		const realRoot = realpathSync.native(worktrees);
		const sibling = join(common, "worktrees", "good");
		mkdirSync(sibling);
		mkdirSync(join(worktrees, "GOOD"));
		writeFileSync(join(sibling, "gitdir"), `${join(realRoot, "GOOD")}/.git\n`);

		const trav = join(common, "worktrees", "trav");
		mkdirSync(trav);
		writeFileSync(join(trav, "gitdir"), `${realRoot}/../escape/.git\n`);

		const outside = join(fx.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(worktrees, "LINK"));
		const sym = join(common, "worktrees", "sym");
		mkdirSync(sym);
		writeFileSync(join(sym, "gitdir"), `${join(realRoot, "LINK")}/.git\n`);

		writeFileSync(join(common, "worktrees", "plainfile"), "x");

		const res = validateWorktreeGitdirs(common, worktrees);
		expect(res.ok).toBe(false);
		expect(res.invalid.sort()).toEqual(["plainfile", "sym", "trav"]);
	});
});

describe("remote URL trust (insteadOf post-check)", () => {
	let fx: SessionFixture;
	beforeEach(() => {
		fx = makeSessionFixture();
		git(
			fx.repo,
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widgets.git",
		);
	});
	afterEach(() => fx.cleanup());

	it("accepts a clean config", () => {
		const inv = fx.gitEnv.repoScope(fx.repo);
		expect(fx.gitEnv.trustedRemoteUrl(inv)).toBe(
			"https://github.com/acme/widgets.git",
		);
	});

	it("detects url.<evil>.insteadOf and the fetch is skipped without a connection", async () => {
		git(
			fx.repo,
			"config",
			"url.https://evil.example/.insteadOf",
			"https://github.com/",
		);
		const inv = fx.gitEnv.repoScope(fx.repo);
		expect(() => fx.gitEnv.trustedRemoteUrl(inv)).toThrow(/insteadOf/);

		const warn = vi.fn();
		const service = new GitService({ cyrusHome: join(fx.root, "home") }, {
			...silentLogger,
			warn,
		} as unknown as ILogger);
		await service.createGitWorktree(
			{
				id: "i3",
				identifier: "ENG-3",
				title: "t",
				branchName: "eng-3",
			} as never,
			[
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: fx.repo,
					workspaceBaseDir: join(fx.root, "worktrees"),
					baseBranch: "main",
				} as never,
			],
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("skipping network git"),
		);
		// Offline fallback: no remote-tracking refs were fetched.
		expect(git(fx.repo, "for-each-ref", "refs/remotes").trim()).toBe("");
	});

	it("rejects a remote URL that looks like an option", () => {
		git(fx.repo, "config", "remote.origin.url", "--upload-pack=evil");
		const service = new GitService({ cyrusHome: join(fx.root, "home") });
		return expect(
			service.branchExists("nonexistent-branch", fx.repo),
		).resolves.toBe(false);
	});
});

describe("parseGithubSlug", () => {
	it.each([
		["https://github.com/acme/widgets.git", "acme/widgets"],
		["https://github.com/acme/widgets", "acme/widgets"],
		["git@github.com:acme/widgets.git", "acme/widgets"],
		["https://x-access-token:abc@github.com/acme/widgets.git", "acme/widgets"],
	])("%s", (url, slug) => expect(parseGithubSlug(url)).toBe(slug));

	it("rejects other hosts and lookalikes", () => {
		expect(parseGithubSlug("https://evil.example/acme/widgets.git")).toBeNull();
		expect(parseGithubSlug("https://github.com.evil.example/a/b")).toBeNull();
		expect(parseGithubSlug("/local/path")).toBeNull();
	});
});

describe("gh scope", () => {
	it("uses an explicit token, an empty throwaway config dir and a PATH without the shim", () => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-gh-scope-"));
		try {
			const ge = new GitEnv({ cyrusHome: root, ghBinary: "/usr/bin/gh" });
			process.env.GH_TOKEN = "ambient";
			const gh = ge.ghScope("explicit-token");
			expect(gh.binary).toBe("/usr/bin/gh");
			expect(gh.cwd).toBe(root);
			expect(gh.env.GH_TOKEN).toBe("explicit-token");
			expect(gh.env.GH_PROMPT_DISABLED).toBe("1");
			expect(gh.env.GH_NO_UPDATE_NOTIFIER).toBe("1");
			expect(gh.env.PATH?.split(":")).not.toContain("/usr/local/bin");
			expect(gh.env.GH_CONFIG_DIR).toBeTruthy();
			gh.cleanup();
			expect(
				new GitEnv({ cyrusHome: root, ghBinary: "/x" }).ghScope(undefined).env
					.GH_TOKEN,
			).toBeUndefined();
			expect(() => new GitEnv({ cyrusHome: root }).ghScope("t")).toThrow(
				/ghBinary/,
			);
		} finally {
			delete process.env.GH_TOKEN;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

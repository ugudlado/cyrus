import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";
import { GitEnv, SessionGit } from "../src/gitEnv.js";
import {
	applyIntentToAdd,
	DefaultIntentToAddGitClient,
} from "../src/hooks/IntentToAddHook.js";
import { inspectGitGuardrail } from "../src/RunnerConfigBuilder.js";
import { git, makeSessionFixture } from "./helpers/sessionGitFixture.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

/**
 * Vector 3 of the plan: inside the session's OWN clone the session can write
 * `.git/config`, hooks and extra pointer files. Every parent git call must
 * still run none of it.
 */
describe("evil clone: planted config, hooks and pointers", () => {
	let root: string;
	let ws: string;
	let markers: string;
	let sessionGitApi: SessionGit;
	let cleanup: () => void;
	let sourceRepo: string;

	beforeEach(async () => {
		const base = makeSessionFixture({ remote: true });
		cleanup = base.cleanup;
		root = base.root;
		sourceRepo = base.repo;
		git(base.repo, "worktree", "remove", "--force", base.ws);
		git(base.repo, "checkout", "main");
		const service = new GitService(
			{
				cyrusHome: join(root, "home"),
				gitAllowFileProtocol: true,
				cloneMinFreeBytes: 0,
			},
			silentLogger,
		);
		const created = await service.createGitWorktree(
			{
				id: "i",
				identifier: "ENG-1",
				title: "t",
				branchName: "eng-1",
			} as never,
			[
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: base.repo,
					workspaceBaseDir: join(root, "home", "worktrees"),
					baseBranch: "main",
				} as never,
			],
		);
		ws = created.path;
		markers = join(root, "markers");
		mkdirSync(markers);
		const script = (name: string) => {
			const p = join(root, name);
			writeFileSync(
				p,
				`#!/bin/sh\necho ran >> "${markers}/${name}"\nprintf '\\0'\n`,
			);
			chmodSync(p, 0o755);
			return p;
		};
		// Planted by the "session" in its own clone.
		const cfg = join(ws, ".git", "config");
		writeFileSync(
			cfg,
			`${readFileSync(cfg, "utf8")}[core]\n\tfsmonitor = ${script("fsmonitor.sh")}\n\tsshCommand = ${script("ssh.sh")}\n[credential]\n\thelper = !${script("credential.sh")}\n[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n`,
		);
		for (const h of [
			"pre-commit",
			"post-checkout",
			"reference-transaction",
			"post-merge",
			"post-index-change",
		]) {
			const p = join(ws, ".git", "hooks", h);
			writeFileSync(p, `#!/bin/sh\necho ran >> "${markers}/hook-${h}"\n`);
			chmodSync(p, 0o755);
		}
		const gitEnv = new GitEnv({ cyrusHome: join(root, "home") });
		sessionGitApi = new SessionGit(gitEnv, [
			{
				repositoryId: "repo-1",
				repositoryPath: base.repo,
				workspacePath: ws,
			},
		]);
	});
	afterEach(() => cleanup());

	it("NEGATIVE CONTROL: unpinned git in the clone runs the planted config", () => {
		writeFileSync(join(ws, "README.md"), "changed\n");
		for (const args of [
			["status", "--porcelain"],
			["add", "--intent-to-add", "--", "new.ts"],
		]) {
			writeFileSync(join(ws, "new.ts"), "x\n");
			try {
				execFileSync("git", args, { cwd: ws, stdio: "ignore" });
			} catch {
				// the marker is what matters
			}
		}
		expect(readdirSync(markers)).toContain("fsmonitor.sh");
	});

	it("pinned parent calls (Stop guardrail, intent-to-add, fetch, reuse) run none of it", async () => {
		writeFileSync(join(ws, "README.md"), "changed\n");
		const guard = inspectGitGuardrail(ws, silentLogger, sessionGitApi);
		expect(guard).toContain("uncommitted file change");
		const f = join(ws, "new.ts");
		writeFileSync(f, "x\n");
		applyIntentToAdd(
			new DefaultIntentToAddGitClient(sessionGitApi),
			ws,
			f,
			silentLogger,
		);
		// Reuse path: re-stamp + fetch + ff under the pins.
		const service = new GitService(
			{
				cyrusHome: join(root, "home"),
				gitAllowFileProtocol: true,
				cloneMinFreeBytes: 0,
			},
			silentLogger,
		);
		await service.createGitWorktree(
			{
				id: "i",
				identifier: "ENG-1",
				title: "t",
				branchName: "eng-1",
			} as never,
			[
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: sourceRepo,
					workspaceBaseDir: join(root, "home", "worktrees"),
					baseBranch: "main",
				} as never,
			],
		);
		expect(readdirSync(markers)).toEqual([]);
		// and the planted keys are gone after the re-stamp
		expect(readFileSync(join(ws, ".git", "config"), "utf8")).not.toContain(
			"evil",
		);
	});

	it("a planted commondir fails the shape check: no git runs, the hooks return no-ops", () => {
		writeFileSync(
			join(ws, ".git", "commondir"),
			`${join(root, "elsewhere")}\n`,
		);
		writeFileSync(join(ws, "README.md"), "changed\n");
		// null = no trusted target: the Stop hook does not block, nothing runs.
		expect(inspectGitGuardrail(ws, silentLogger, sessionGitApi)).toBeNull();
		const f = join(ws, "new.ts");
		writeFileSync(f, "x\n");
		applyIntentToAdd(
			new DefaultIntentToAddGitClient(sessionGitApi),
			ws,
			f,
			silentLogger,
		);
		expect(readdirSync(markers)).toEqual([]);
	});

	it("the pins hold even where the shape check would not catch the plant", () => {
		// Config-only plants pass the shape check by design; the pins neutralise them.
		const inv = sessionGitApi.invocationFor(ws);
		expect(inv).not.toBeNull();
		expect(inv?.env.GIT_DIR).toBe(inv?.env.GIT_COMMON_DIR);
		expect(inv?.env.GIT_CONFIG_COUNT).toBeDefined();
	});
});

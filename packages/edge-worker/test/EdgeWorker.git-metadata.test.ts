import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

const git = (cwd: string, cmd: string) =>
	execSync(`git ${cmd}`, { cwd, stdio: "pipe", encoding: "utf8" });

// The same helper feeds both the sandbox write grant and `allowedDirectories`
// (-> `Read(<dir>/**)` tool grants and home-dir deny exemptions).
describe("EdgeWorker validated git metadata directories", () => {
	let root: string;
	let repo: string;
	let worktree: string;
	let fakeHome: string;
	let worker: any;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "cyrus-ew-gitmeta-")));
		repo = join(root, "repo");
		worktree = join(root, "wt");
		fakeHome = join(root, "home-cyrus");
		mkdirSync(repo);
		mkdirSync(fakeHome);
		git(repo, "init -q -b main");
		git(
			repo,
			"-c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
		);
		git(repo, `worktree add -q -b feature ${worktree}`);
		worker = new EdgeWorker({
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: repo,
					workspaceBaseDir: join(root, "wts"),
					linearWorkspaceId: "ws",
					baseBranch: "main",
				},
			],
			linearWorkspaces: { ws: { linearToken: "t" } },
		} as EdgeWorkerConfig);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const workspace = () => ({ path: worktree, isGitWorktree: true });

	it("returns the repository's own common .git", () => {
		expect(
			worker.getValidatedGitMetadataDirectories(
				workspace(),
				worker.repositories.get("repo-1"),
			),
		).toEqual([join(repo, ".git")]);
	});

	it("yields no entry for a hostile commondir pointing at ~/.cyrus", () => {
		// objects/ and refs/ stubs make git accept the hostile directory
		mkdirSync(join(fakeHome, "objects"));
		mkdirSync(join(fakeHome, "refs"));
		writeFileSync(join(fakeHome, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(
			join(repo, ".git", "worktrees", "wt", "commondir"),
			`${fakeHome}\n`,
		);
		const dirs = worker.getValidatedGitMetadataDirectories(
			workspace(),
			worker.repositories.get("repo-1"),
		);
		expect(dirs).toEqual([]);
		expect(dirs).not.toContain(fakeHome);
	});
});

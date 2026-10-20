import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

// Uses a real git repo + linked worktree on disk: the validation is about
// realpath/containment, which mocks cannot exercise.
const git = (cwd: string, cmd: string) =>
	execSync(`git ${cmd}`, { cwd, stdio: "pipe", encoding: "utf8" });

describe("GitService.getWritableGitMetadataDirectories", () => {
	let root: string;
	let repo: string;
	let worktree: string;
	let outside: string;
	let warn: ReturnType<typeof vi.fn>;
	let service: GitService;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "cyrus-gitmeta-")));
		repo = join(root, "repo");
		worktree = join(root, "wt");
		outside = join(root, "fake-cyrus-home");
		mkdirSync(repo);
		mkdirSync(outside);
		git(repo, "init -q -b main");
		git(
			repo,
			"-c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
		);
		git(repo, `worktree add -q -b feature ${worktree}`);
		warn = vi.fn();
		service = new GitService({ cyrusHome: root }, {
			debug: vi.fn(),
			info: vi.fn(),
			warn,
			error: vi.fn(),
		} as any);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const targets = () => [{ workingDirectory: worktree, repositoryPath: repo }];

	it("returns only the common .git for a healthy linked worktree (never the worktrees/<n> gitdir)", () => {
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).toEqual([join(repo, ".git")]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("never returns a .git/worktrees path, even when the entry is replaced by a symlink", () => {
		const wtEntry = join(repo, ".git", "worktrees", "wt");
		rmSync(wtEntry, { recursive: true, force: true });
		symlinkSync(outside, wtEntry);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result.some((d) => d.includes(`${sep}worktrees`))).toBe(false);
		expect(result).not.toContain(outside);
	});

	it("rejects a commondir rewritten to point at a real repo outside", () => {
		// Make `outside` a genuine git dir so rev-parse really reports it.
		git(outside, "init -q --bare .");
		writeFileSync(
			join(repo, ".git", "worktrees", "wt", "commondir"),
			`${outside}\n`,
		);
		expect(git(worktree, "rev-parse --git-common-dir").trim()).toBe(outside);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("outside"));
	});

	it("rejects a worktree .git file whose gitdir points outside the repo", () => {
		git(outside, "init -q --bare .");
		writeFileSync(join(worktree, ".git"), `gitdir: ${outside}\n`);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).not.toContain(outside);
		expect(result).toEqual([]);
	});

	it("validates each repo of a multi-repo workspace against its own .git", () => {
		const repoB = join(root, "repo-b");
		const worktreeB = join(root, "wt-b");
		mkdirSync(repoB);
		git(repoB, "init -q -b main");
		git(
			repoB,
			"-c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
		);
		git(repoB, `worktree add -q -b feature ${worktreeB}`);

		// repo A's worktree claiming repo B's .git is rejected, B's own is kept.
		const result = service.getWritableGitMetadataDirectories([
			{ workingDirectory: worktree, repositoryPath: repoB },
			{ workingDirectory: worktreeB, repositoryPath: repoB },
		]);
		expect(result).toEqual([join(repoB, ".git")]);
	});

	it("skips a repository whose .git cannot be resolved", () => {
		const result = service.getWritableGitMetadataDirectories([
			{ workingDirectory: worktree, repositoryPath: join(root, "missing") },
		]);
		expect(result).toEqual([]);
		expect(warn).toHaveBeenCalled();
	});
});

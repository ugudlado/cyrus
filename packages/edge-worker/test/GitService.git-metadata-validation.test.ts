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
import { join } from "node:path";
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

	it("returns the common .git and the worktree gitdir for a healthy linked worktree", () => {
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(new Set(result)).toEqual(
			new Set([join(repo, ".git"), join(repo, ".git", "worktrees", "wt")]),
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("rejects a commondir rewritten to point outside the repo", () => {
		writeFileSync(
			join(repo, ".git", "worktrees", "wt", "commondir"),
			`${outside}\n`,
		);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).not.toContain(outside);
		expect(result.every((d) => d.startsWith(join(repo, ".git")))).toBe(true);
	});

	it("rejects a worktree .git file whose gitdir points outside the repo", () => {
		writeFileSync(join(worktree, ".git"), `gitdir: ${outside}\n`);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).not.toContain(outside);
		expect(result).toEqual([]);
	});

	it("rejects a gitdir that is inside .git but not under worktrees/", () => {
		mkdirSync(join(repo, ".git", "hooks-evil"));
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(repo, ".git", "hooks-evil")}\n`,
		);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).not.toContain(join(repo, ".git", "hooks-evil"));
	});

	it("rejects a symlink inside .git/worktrees that escapes the repo", () => {
		symlinkSync(outside, join(repo, ".git", "worktrees", "escape"));
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(repo, ".git", "worktrees", "escape")}\n`,
		);
		const result = service.getWritableGitMetadataDirectories(targets());
		expect(result).not.toContain(outside);
		expect(result).not.toContain(join(repo, ".git", "worktrees", "escape"));
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
		expect(new Set(result)).toEqual(
			new Set([join(repoB, ".git"), join(repoB, ".git", "worktrees", "wt-b")]),
		);
	});

	it("skips a repository whose .git cannot be resolved", () => {
		const result = service.getWritableGitMetadataDirectories([
			{ workingDirectory: worktree, repositoryPath: join(root, "missing") },
		]);
		expect(result).toEqual([]);
		expect(warn).toHaveBeenCalled();
	});
});

# A12 fork patch — Fable code review, round 2

Date: 2026-10-21. Reviewer: Fable (read-only; resumed with round-1 context). Fix commit `8b66b798` on `fix/sandbox-worktree-git-write` (on top of `3bf08bf0`, `4ac33658`).

## Verdict (summary)

VERDICT: APPROVED. BLOCKING: none.

- Both round-1 blocking items are closed:
  - the grant is only `realpathSync.native(<repo>/.git)`, when the worktree's common dir resolves exactly to it, and nothing under `.git/worktrees/`;
  - `allowedDirectories` at both sites is validated.
- No regression: the worktree gitdir sits inside the granted common dir, and multi-repo validation is per repo.
- Tests are now non-vacuous.
- `getGitMetadataDirectoriesForWorkspace` is now dead in-tree; keep it or remove it in the upstream PR.
- CHANGELOG links come later.

SECURITY NOTES:
- The grant is anchored on operator config. Session-writable inputs can only withhold the grant.
- The residual accepted power is unchanged (rw on the common `.git`). Config and hooks rely on Claude Code's deny binds, which still need proving on the box.
- The flag must be set in `cyrus.service`, and the managed attribution setting must exist.
- The end-to-end proof is the box acceptance pass.

## Disposition

Approved. Step 0 (stock `writablePaths`) is skipped by planner decision: commit 1 is kept because it also removes the main checkout from `allowRead` and validates paths, and the reviewer expected `writablePaths` alone to fail through `allowRead` shadowing. Deploy follows.

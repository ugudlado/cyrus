# A12 fork patch — Fable code review, round 1

Date: 2026-10-21. Reviewer: Fable (read-only). Commits `3bf08bf0` and `4ac33658` on `fix/sandbox-worktree-git-write`.

## Verdict (summary)

VERDICT: CHANGES_REQUESTED.

BLOCKING:
1. The per-worktree gitdir grant (`<repo>/.git/worktrees/<wt>`) can be swapped by the session for a symlink after validation (it has rw on the parent `.git`). The next bwrap `--bind` would then follow it and mount `~/.cyrus` rw. The grant is also redundant. Fix: grant only the common dir equal to `realpath(<repo>/.git)`.
2. `allowedDirectories` still uses the unvalidated git dirs (`EdgeWorker.ts` ~4505, ~7754). ClaudeRunner turns them into `Read(<dir>/**)` grants and home-dir deny exemptions, so a hostile `commondir` would expose `~/.cyrus` to the Read tool. Fix: use the validated dirs there.

NON-BLOCKING:
- The "commondir outside" test can pass vacuously; use a real bare repo and assert the warn.
- Use `realpathSync.native`, and add a debug log for a missing `repoId`.
- CHANGELOG: note the flag-off behaviour change (no Bash read of the main checkout), and scope the Added entry to Claude (Gemini, Codex and Cursor are not gated).
- Skills-name scan: add a comment.
- Stacked doc blocks.
- Tests reach into privates, but they are acceptable.
- The gates were verified complete for the Claude path.
- The attachments path matches all producers.
- CHANGELOG PR links come later.

SECURITY NOTES:
- The validation logic is sound: exact realpath equality for the common dir, and a separator-anchored prefix check for worktrees.
- `.git/config` and hooks protection must be proven on the box.
- The flag is env-only, so `cyrus.service` must set it.
- The managed attribution setting must exist.
- The end-to-end flow is unproven until the box acceptance pass.

## Disposition

All items sent to the executor as follow-up commits on the same branch. Round 2 follows.

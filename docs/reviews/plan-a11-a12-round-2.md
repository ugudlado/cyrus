# Plan amendments A11 + A12 — Fable review, round 2

Date: 2026-10-21. Reviewer: Fable (read-only; resumed with round-1 context).

## Verdict (summary of the verbatim report)

VERDICT: CHANGES_REQUESTED.

BLOCKING:
1. Worktree `.claude/settings.json` and `settings.local.json` are loaded through `settingSources: ["user","project","local"]` (`ClaudeRunner.ts:671`, `EdgeWorker.ts:7270`), and Cyrus itself writes `settings.local.json` (`EdgeWorker.ts:4482-4493`). From those files:
   - `apiKeyHelper` outranks `CLAUDE_CODE_OAUTH_TOKEN`;
   - `awsAuthRefresh`/`awsCredentialExport` can run commands;
   - the `env` block can set `ANTHROPIC_*` or the scrub flag.

   Result: unsandboxed code execution or credential redirect. Fix: `settingSources: ["user"]` in untrusted mode, stop writing the worktree settings file, and move `includeCoAuthoredBy` to user settings.
2. The new `gitMetadataDirectories` come from session-writable files (the worktree `.git` and `commondir`). Fix: `realpath` each one and grant it only inside `<repositoryPath>/.git`, with a unit test.

NON-BLOCKING:
- Managed `env` with the scrub flag set to 1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Do not use `allowManagedPermissionRulesOnly` or `allowManagedDomainsOnly`.
- Other inputs were checked and are prompt text only or already covered.
- Keep admin-owned `~/.cyrus` files in the stat check.
- `cyrus-setup.sh` from the committed base stays M-gated via PR review; add a reviewer checklist.

SECURITY NOTES:
- After these fixes, session-writable content reaches only sandboxed processes, the pushed public branch, Linear via MCP, and the model's context.
- `apiKeyHelper` precedence makes any writable settings source equivalent to credential takeover.
- No secret values appear.

## Disposition

All items applied in PLAN.md A11 and A12 (commit 2 settings sources, commit 1 path validation, managed `env` and auto-memory, new acceptance rows, reviewer checklist). Re-submitted as round 3.

# Plan amendments A11 (guardrails) + A12 (fork patch) — Fable review, round 1

Date: 2026-10-21. Reviewer: Fable (read-only subagent; web lookups allowed).

## Verdict (summary of the verbatim report)

VERDICT: CHANGES_REQUESTED.

BLOCKING:
1. A session can write `cyrus-teardown.sh`/`cyrus-setup.sh` in the worktree. Cyrus runs them itself, unsandboxed and with the full `process.env` (`GitService.ts:1263-1300`, `~1455-1460`).
2. A session can write the worktree `.env`. Cyrus loads it after the base env on every start or resume (`ClaudeRunner.ts:1195-1216`, `677-680`), so it could turn the scrub off or inject `ANTHROPIC_API_KEY`.
3. `WebFetch`/`WebSearch` are on by default (`allowed-tools-defaults.ts:44-45`) and run outside the sandbox and egress proxy, so they are an exfiltration channel.
4. `Grep(…)`/`Glob(…)` deny rules are inert; only `Read`/`Edit` rules are consulted.

NON-BLOCKING:
- The scrub reaches the CLI on both paths (`session-env.ts:54-56`, `ClaudeRunner.ts:677`, `EdgeWorker.ts:7274`), and nothing in Cyrus unsets it.
- Managed settings path and behaviour are verified:
  - the path is `/etc/claude-code/managed-settings.json`;
  - lists merge across scopes, and managed deny is final;
  - the SDK reads managed settings regardless of `settingSources`;
  - the env deny unsets before the command, so the `gh` wrapper still works.
- Cyrus's Linear and cyrus-tools MCP servers are HTTP and unaffected by the scrub or the env deny.
- Add `allowManagedHooksOnly`, plus seatbelt `Edit(…)` denies. The worktree `.mcp.json` is loaded (`ClaudeRunner.ts:585-597`).
- Branch protection: free on public repos. Bypass lists are org-only. Require approval of the most recent push. A GitHub App's review may count toward required approvals, so M should never open PRs there. Push protection must be enabled explicitly, and its pattern list was given. Disable Actions, Wiki and Pages. Pushed branches become public (accepted consequence).
- The pre-push hook is bypassable, so it is a seatbelt only. The orchestrator and graphite prompts use `git push -u`.
- `maxTurns: 200` is hard-coded, with no wall-clock cap; record it as a gap.
- A12 root cause is confirmed with source refs. Try `sandbox.writablePaths` on 0.2.74 first. The patch shape needs a separate `gitMetadataDirectories` field, and must keep `attachmentsDir` readable.
- A12 acceptance should prove that hooks and config in the common `.git` stay protected. Record the cross-session write power.
- Build as an unprivileged user and then chown to root. `cyrus-admin` uses the same binary as the service. Both 0.2.73 and 0.2.74 pin SDK 0.3.281.
- Mark A8's "no fork code", the §12 row and the install header as superseded.

SECURITY NOTES:
- The two BLOCKING worktree paths were the only places where session-writable content reaches an unsandboxed process.
- The remaining accepted exposure is: the gh write token, the egress allowlist, the Linear and cyrus-tools MCP servers, and pushed branches once the repo is public.
- `Read(//proc/**)` together with the PID namespace covers `/proc/*/environ`.
- No secret values appear.

## Disposition

All BLOCKING and NON-BLOCKING items are applied in PLAN.md:
- **A11:** `WebFetch`/`WebSearch` denied; only `Read` rules kept; managed hooks/MCP settings and seatbelt `Edit` denies added; branch-protection wording and repo hardening added; the `maxTurns` gap recorded.
- **New acceptance rows:** a session-written teardown file is not run, a session-written `.env` has no effect, `WebFetch` is denied, and `gh` still works.
- **A12:** a step 0 `writablePaths` test; commit 2 adds an untrusted-worktree mode (`CYRUS_UNTRUSTED_WORKTREE=1`: skip worktree hook scripts, `.env` and `.mcp.json`); the `gitMetadataDirectories` patch shape; the superseded A8 text; an unprivileged build; and hooks/config protection plus state-load acceptance.

Re-submitted as round 2.

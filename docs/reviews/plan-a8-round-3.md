# Plan amendments A8 + A9 — Fable review, round 3

Date: 2026-10-21. Reviewer: Fable (read-only subagent, resumed with rounds 1–2 context).

## Verdict (verbatim)

```
VERDICT: APPROVED
BLOCKING:
- none
NON-BLOCKING:
- [PLAN.md:114] §6 acceptance says "Production units run with `LOG_LEVEL=info`"; the variable stock Cyrus reads is `CYRUS_LOG_LEVEL` (`packages/core/src/logging/Logger.ts:30`), as the Phase 2 prep executor also found. Correct the text so the unit sets the right name (`CYRUS_LOG_LEVEL=INFO`).
- [PLAN.md:105] §6.5 still says `cyrus.service (User=cyrus, …)`; A6/A7 require `ExecStart=/usr/local/libexec/cyrus-run cyrus …` with **no** `User=` line. Annotate inline like §6.2 so Phase 2 does not follow the stale sentence.
- [PLAN.md:93] §5 acceptance still ends "env file perms `0640`"; step 7 was annotated but the acceptance line was not. Annotate to `root:root 0600` (A9).
- [PLAN.md:40] §2 row 5 ("pastes it into the VM secret file over SSH") is superseded by A9's `instabox secrets set` on Instabox; annotate for consistency.
- [PLAN.md:104] `projectKeys` and `labelPrompts` are per-repository fields (`docs/CONFIG_FILE.md:194-230`, confirmed by the executor); the wording "explicit `projectKeys` for the sandbox project" is fine but say "on the sandbox repository entry" so it is not read as top-level.
- Installed stock version is 0.2.73 (0.2.74 not on npm). Record the installed version in A6/`assumptions.md`, and note that the `EdgeWorker.ts`/`SelfAuthCommand.ts`/`ConfigUpdater.ts` line references in A8/A9 are from the 0.2.74 source checkout (the executor reports the names/paths match the installed package; keep that statement with the version).
- `cyrus-admin`: `systemd-run --pty` needs a controlling terminal; over `instabox ssh` the parent must allocate one (`ssh -t` equivalent) or the command fails before the OAuth URL is printed. Also `self-auth-linear` requires M to finish the OAuth flow in a browser against `CYRUS_BASE_URL/callback`, so the public port must be published and routed to 3456 while the transient service holds the port, and unpublished again afterwards. Add both to the Phase 2 steps.
- Git auth path is sound: global credential helper `!/usr/bin/gh auth git-credential` for user `cyrus` with `GITHUB_TOKEN` only in the service/timer env, so no token lands in a remote URL or `.git/config`; Cyrus's own `ensureGitHubCredentialHelper` is only invoked when a hosted token store exists (`EdgeWorker.ts:651-663`), which is not the case here. For `mirror-refresh.service` (A9 h) the same helper applies; confirm in 3a that `gh auth git-credential` works with just `GITHUB_TOKEN` and no `~/.config/gh/hosts.yml` (transcript, names only).
- A8 fallback caveats, Grep/Glob path bound, `LINEAR_CLIENT_*` startup guard, bridge details (a)-(h), `~cyrus/.cyrus/.env` immutable guard, §11 env-dump rule, and the VPS note are all present and concrete; nothing further needed before Phase 2 resumes.
SECURITY NOTES:
- All round-1 and round-2 items are closed with testable text. The core rule (tickets only through the deterministic gate on `/ticket`, `[ticket]`, or a sender-confirmed proposal) and every §7 3b-3d security requirement survive in A8; the chat agent has no Linear client, an exact tool allow list, scrubbed env, `settingSources: []`, strict MCP, OS sandbox, and a `canUseTool` guard, each with a named unit test.
- Secrets: env files `root:root 0600`, bridge files on tmpfs `root:root 0600`, read by systemd as root before `cyrus-run` drops privileges; service users cannot read any env file (test #22). Known, accepted residuals: the admin login user's shells (now covered by the §11 no-dump rule), and stock Cyrus's `linearToken`/refresh token in `~cyrus/.cyrus/config.json`.
- `cyrus-admin` is the only new privileged path; it reuses the service's two `EnvironmentFile=`s and `cyrus-run`, is interactive and one-off, and leaves no root-owned files in `~cyrus`.
- The latest Phase 2 prep transcript (`infra/transcripts/instabox-cyrus-test-install-cyrus-20261020T212041Z.log`) contains key names only; grep for `lin_oauth`, `sk-ant-oat`, `whsec_`, `ghp_`, `github_pat_` returns 0 matches. No secret values in the revised PLAN.md or the round-1/round-2 records.
```

## Disposition

All NON-BLOCKING items applied in PLAN.md (§2 row 5, §5 acceptance, §6.4, §6.5, §6 acceptance, plus Phase 2 execution notes with the version statement and the `cyrus-admin` TTY/publish steps). The `gh auth git-credential` check is carried into the Phase 2 infra step. A8 + A9 are approved.

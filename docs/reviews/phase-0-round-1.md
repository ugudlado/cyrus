# Phase 0 — Fable review, round 1

Date: 2026-10-21. Reviewer: Fable (read-only subagent, PLAN.md §9 / §13 A3).

## Evidence added after review (requested verbatim)

`node --test` in `cyrus-sandbox-app` at `5213a40`:

```
✔ unknown path returns 404 (1.969666ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 75.899292
```

## Verdict

```
VERDICT: APPROVED
BLOCKING:
- none
NON-BLOCKING:
- [docs/intake/baseline.md:13] says `pnpm lint` passed with "2 pre-existing warnings"; the log shows 14: 11x complexity/useOptionalChain (FIXABLE), 2x suspicious/noTemplateCurlyInString in apps/cli/test-release.test.ts, 1x complexity/noStaticOnlyClass in packages/core/src/security/WebhookIpValidator.ts. Correct the record so Phase 3's "no new lint warnings" comparison is like for like.
- Open question (a): yes, the clean-env baseline is an acceptable recorded baseline. Both runs are logged with exit codes, the 8 dirty-shell failures are explained, and the root cause is real: RunnerSelectionService.ts:30-49 auto-selects "gemini" when GEMINI_API_KEY is the only credential present. Keep using `pnpm -r test:run` under `env -i` as the canonical command for Phase 3 acceptance.
- Sandbox-app test evidence is a paraphrase, not verbatim output. The test file is sound, so accepted, but paste the verbatim `node --test` summary into docs/reviews/phase-0-round-1.md.
- Node v24.0.0 is a pre-LTS release of the 24 line (24.x entered LTS at 24.11). On the VM pin an actual 24.x LTS release and record the exact version.
- docs/reviews/ contains only .gitkeep. Save this round as docs/reviews/phase-0-round-1.md before starting Phase 1.
- cyrus-sandbox-app/.claude/ exists as an untracked directory. Keep the sandbox repo minimal so Cyrus worktrees pick up no stray harness config.
- Phase 2 config.json: set `defaultRunner: "claude"` explicitly rather than relying on credential auto-detect, so a stray provider key on the VM can never change the runner. Linear sessions should be pinned too.
- Open question (c): nothing blocking before Phase 1. Carry forward: fix the lint count, save the review record, measure Instabox wake latency in Phase 1.
SECURITY NOTES:
- No secret values found in the baseline logs, docs/intake/*.md, or any cyrus-sandbox-app file. The only `lin_oauth_` matches are biome quoting a source-code prefix check in SelfAuthCommand.ts, not a token. No ANTHROPIC_API_KEY anywhere. Fork remotes correct: origin ugudlado, upstream push DISABLED.
- A GEMINI_API_KEY exists in M's laptop shell (value never printed). It must not reach the VM: the box was created with `--secrets none --env-secrets none`, and infra/provision.sh must never copy laptop env; secrets only via /etc/cyrus/cyrus.env (root:cyrus, 0640).
- §13 A2 `HARDEN_NETWORK=no` / `INGRESS=instabox` is acceptable on this box. Conditions: (1) provision.sh must default to `HARDEN_NETWORK=yes` and a public-ingress profile when unset, so a VPS run cannot silently inherit the relaxed profile; (2) Cyrus must bind 127.0.0.1:3456 only.
- .gitignore `!infra/targets/*.env` re-includes env files in a committed repo. Profiles must hold only non-secret knobs. Add a guard in provision.sh that refuses any profile key matching *_TOKEN, *_SECRET, *_KEY, *PASSWORD, and say so in a comment at the top of each profile.
- Auto-pause vs Svix 5-minute tolerance: measure wake-to-first-response in Phase 1 and record it in assumptions.md.
- A3: this round was spawned with Bash available, not only Read/Grep/Glob. Only read-only commands were used. Spawn future rounds with the restricted tool set where the harness allows it.
- Allowlist-in-code, raw-body webhook verification, Linear-write isolation, idempotency: not applicable to Phase 0; checked from 3a onward. sandbox-requirements.ts matches assumptions.md #3.
```

## Disposition

| Item | Action |
|---|---|
| Lint warning count | Fixed in `docs/intake/baseline.md`. |
| Verbatim sandbox test output | Added above. |
| Node LTS on VM | Carried to Phase 1 (pin 24.x LTS, record version). |
| Review record | This file. |
| Sandbox `.claude/` | It holds only Claude Code's own write-tracking file (`.cc-writes`, managed by the harness on the developer laptop). Added `.claude/` to the sandbox repo's `.gitignore` so it can never be committed. |
| `defaultRunner: "claude"` | Carried to Phase 2 (PLAN.md §13 A5). |
| Safe-by-default profile, secret-key guard, 127.0.0.1 bind | Carried to Phase 1 (PLAN.md §13 A5). |
| Wake latency vs Svix tolerance | `assumptions.md` #5; measured in Phase 1. |
| Read-only reviewer tools | Future rounds spawn the `fable-reviewer` agent type if the session has loaded it; otherwise a no-write agent type, instructed read-only. |

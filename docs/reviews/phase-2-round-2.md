# Phase 2 — Fable review, round 2

Date: 2026-10-21. Reviewer: Fable (read-only; resumed with round-1 context).

## Verdict (summary)

VERDICT: APPROVED. BLOCKING: none.

NON-BLOCKING (all applied in workspace PLAN.md, or carried as §13 A13):
- Mark the `.git/hooks` and `git config --local` checks as evidenced by CYR-7. Retire two stale "still to test" sentences.
- CYR-7's `git config --local` refusal comes from Claude Code's `config.lock` placeholder. Keep the runbook note, and re-check the placeholders after the next Claude Code upgrade.
- The A8 routing change has not had its own plan review. In the 3b review, the gateway must fail closed unless the team and project map to exactly one repo. Add a Phase 4 row for tag-less routing.
- Phase 3a: call `scan_anthropic_key` per service home and add `/etc/intake`.
- `run-on.sh` re-publishes 3456; unpublish after each test window.
- Carry-forward list for Phase 3: delegate user id, gateway app user, the `intake` bridge allowlist, `intake-gateway.service` via `cyrus-run`, the Phase 4 rows and deferred items, and the known gaps.

SECURITY NOTES:
- The round-1 blocking items are closed with evidence (14 probes, CYR-7).
- No secret values appear.
- IP validation is not a meaningful control behind the Instabox proxy; Linear webhooks are authenticated by signature.
- The Slack deferral is acceptable.
- The accepted exposures are unchanged.
- **Phase 2 is complete for the §9 gate.** Phase 3 may start, subject to A4 (wait for M).

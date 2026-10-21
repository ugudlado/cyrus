# Phase 3b review — round 1 (Fable, 2026-10-21)

Scope: intake-gateway ccb9cea..929d5f2 (ticket gate, Linear client, A14 code items); infra 34cd71d..765750d (A14 infra, A13 routing check, deploy).

VERDICT: CHANGES_REQUESTED

BLOCKING:
1. infra/transcripts/phase-3b-box-checks.txt lacked on-box evidence of "linear ready" (journal + /healthz) and a secret-shape grep. Evidence only; no code change.

NON-BLOCKING:
1. client.ts: also refresh on GraphQL `extensions.code` authentication errors, not only HTTP 401.
2. client.ts: issueCreate ok but issues.add() throws → log "issue created but not recorded" with identifier.
3. gate.ts: on create failure after take(), say the proposal was discarded.
4. gate.ts: labels from proposal-time trust (match the preview), or refuse on change.
5. log.ts: treat client_id as sensitive.
6. Routing check does not skip `isActive:false` repos (stricter; document).
7. Routing check does not guard runner/model selector labels (low risk).
8. PLAN A8 still says "sets the configured project"; record the no-project decision.
9. Pre-test checklist: start github-app-minter after instabox resume.

Security notes (summary): no path creates an issue without a human-typed command; teamId/projectId/stateId/labelIds/delegateId only from frozen resolution and config; tag stripping is a superset of Cyrus's regexes; routing emulation matches Cyrus's order and is stricter; Linear client has no update mutation and refuses unowned ids; A14 infra evidenced on box.

CARRY-FORWARD: transports pass only transport-derived identity; 64 KiB Telegram limit; email SPF/DKIM (A15); propose_ticket schema snapshot; A11 /proc denials; Phase 4 team-routing proof row and entity-encoded tag row; runbook re-run of --check-routing.

## Resolution
- Blocking 1: appended to phase-3b-box-checks.txt (journal "stores loaded" → "linear ready", secret-shape grep count 0, /healthz "linear":"ready").
- Non-blocking 1–5: fixed in the gateway (see round 2).
- 6–9: recorded in PLAN §13 A16.

# Phase 3b review — round 3 (Fable, 2026-10-21)

VERDICT: APPROVED
BLOCKING: none

NON-BLOCKING (carried to the start of 3c, PLAN §13 A16 "3b result"):
1. The installer's healthz-failure journal dump should filter by secret-shape regex, not key words.
2. The "Linear not ready" WARN should go to stderr like the other WARNs.
3. (Round 2, NB2) Sharper test that preview labels equal created labels.

Security notes:
- Evidence is complete for gateway 92aa52a: check log (168 passed), and a deploy transcript showing the pruned tree, idempotent config, routing by team to cyrus-sandbox-app, /etc/intake modes, no safe.directory, 0 token patterns in the mirror, the 127.0.0.1:3457 listener and linear ready.
- Issues are created only by a bound, unexpired, single-use /yes, or by a builder /ticket.
- Identity never comes from tool args, and team, state, label and delegate ids are pinned.
- Routing, agent and model tags (bracketed and bare) are stripped.
- The Linear client is narrow and ownership-gated.
- Auth refresh is bounded.
- Secrets never appear in logs.
- No routes are opened in this phase.

Carry-forward: as recorded in A15/A16.

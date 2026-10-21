# Phase 3b review — round 2 (Fable, 2026-10-21)

VERDICT: CHANGES_REQUESTED
BLOCKING:
1. There was no verbatim build/typecheck/lint/test log for gateway 2cbe21f. Evidence only.

NON-BLOCKING:
1. The trust-changed reply should say the proposal was discarded.
2. Sharper test: preview labels equal created labels.
3. The installer's healthz raced the background Linear resolve; it should poll for "ready".

Resolution: the log is saved as infra/transcripts/phase-3b-gateway-checks-92aa52a.txt (168 passed). NB1 is fixed in gateway 92aa52a. NB3: the installer polls for up to 10 s and prints a WARN otherwise. NB2 is left open.

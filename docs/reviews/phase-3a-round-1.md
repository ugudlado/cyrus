# Phase 3a (intake-gateway skeleton + infra) — Fable review, round 1

Date: 2026-10-21. Reviewer: Fable (read-only). Subject: intake-gateway `ccb9cea` and workspace infra `9f84bd4`.

## Verdict (summary)

VERDICT: APPROVED. BLOCKING: none.

NON-BLOCKING (all carried as PLAN §13 A14, to apply at the start of 3b):
- **Infra and security:**
  - remove the system-wide `safe.directory` for the mirror (cross-user git-config execution risk);
  - `/etc/intake` `root:intake 0710` and `config.json` `0640`, so the sender allowlist is hidden from cyrus;
  - mirror refresh: `git clean -ffdx`, and the branch from config;
  - prod-only runtime tree;
  - make the skipped-scripts WARN actionable and fix the README;
  - a listener summary in `install-intake.sh`;
  - an `intake-admin add-sender` helper (Phase 5);
  - in 3e, scan `/var/lib/intake/claude-home`.
- **Code:**
  - narrow the log key regex and add a value-shape redaction pass;
  - extend `FORBIDDEN_ENV` and delete the parsed secrets from `process.env`;
  - a shared `senderId` helper;
  - `ProposalStore` pruning;
  - a temp-file sweep;
  - document the dedupe await contract;
  - runbook for corrupt state files;
  - a Telegram per-route body limit.
- **Record:** the 3457 exposure under A13.

SECURITY NOTES:
- The secret wrapper, env errors and logger are sound.
- The stores are atomic and refuse symlinks. `take()` is single-use within the event loop. There is a known soft spot: if persist fails after `take`, the proposal could replay within its TTL.
- The infra matches A8/A9: root-only EnvironmentFiles, `intake` isolated, unit hardening consistent with A12.
- Source shipping keeps GitHub credentials off the box. The commit-id check is a consistency check only.
- The mirror is token-free.
- `safe.directory` is the one deviation with a cross-user consequence.
- For 3e: `/proc/<gateway>/environ` is readable by the same uid, so the A11 `/proc` denials are hard requirements.
- No `ANTHROPIC_API_KEY` anywhere.

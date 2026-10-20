# Plan amendments A11 + A12 — Fable review, round 3

Date: 2026-10-21. Reviewer: Fable (read-only; resumed with rounds 1–2 context).

## Verdict (summary of the verbatim report)

VERDICT: APPROVED. BLOCKING: none.

NON-BLOCKING:
- **Can a session write `~cyrus/.claude/settings.json`?**
  - Sandboxed commands cannot: `~/.claude` is on the mandatory protected list, and `allowWrite` cannot lift that.
  - File tools are blocked by the home-dir deny (`Read` deny also blocks Edit/Write on v2.1.228+).
  - Add `Read(//home/cyrus/.claude/**)` to the managed deny list anyway.
  - A root-owned file is tolerated, but the directory is still writable, so it would need `chattr +i`.
  - **Recommended option (d):** `settingSources: []`, with the attribution setting in the managed file, so no cyrus-writable file is a settings source.
- **Acceptance:** no `Co-Authored-By` trailer on bot commits; the settings-file stat (or its absence) is recorded.
- **Docs:** keep the "don't-use" list in `infra/README.md`.

SECURITY NOTES:
- Every loaded settings source is root-owned.
- The cyrus-writable `~/.claude.json` and `~/.cyrus/config.json` are reachable only by unsandboxed processes, and all unsandboxed paths found in rounds 1–2 are closed.
- The `config.json` stat/hash check is the right evidence.
- No secret values appear.

## Disposition

Option (d) adopted: `settingSources: []`, attribution in the managed file, and `Read(//home/cyrus/.claude/**)` denied. Acceptance updated. A11 and A12 are approved.

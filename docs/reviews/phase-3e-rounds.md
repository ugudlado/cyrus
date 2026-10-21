# Phase 3e: chat agent over Telegram (final Fable gate)

Gateway 7c0a4d1..758d772: chat agent (Agent SDK 0.3.292, read-only mirror, `propose_ticket` only), Markdown→Telegram HTML, typing indicator, 👀 reaction, retry for chat action/reaction, fixed content-length. Formatting sub-step approved separately (phase-3e-format-rounds.md).

Tests (outside the sandbox): `Test Files  27 passed (27)` / `Tests  441 passed (441)`.

Live (infra/transcripts/phase-3e-live.txt): code question answered from the mirror; formatting rendered, no entity-parse fallback; change request → preview → /yes → CYR-12 (provenance with display name, label telegram, delegate Cyrus); secret-file read request refused with no contents; /new fresh thread; secret-shape grep over journal since boot 0.

## Round 1: APPROVED
Non-blocking, taken now as hardening before 3g:
1. (major) `allowedTools` pre-approved `Read(//mirror/**)`, so a symlink in the mirror (e.g. to /proc) would bypass the symlink-resolving `canUseTool`; drop it so every Read reaches `canUseTool`, add symlink tests, add a Phase 4 #23 symlink probe.
2. Evidence: capture the SDK child running as `intake` with HOME=/var/lib/intake/claude-home during a run.
3. Log `canUseTool` denials as `{tool, reason-class}` (never paths) so Phase 4 #23 can show "the tool is denied".
6. Lower-case caller headers in the https transport.
7. Record in PLAN §13: denyRead/disallowedTools supersets of A8 (/proc, /root, /sys) and Grep/Glob (now Read) not pre-approved.
8. Carry-forward to docs round: TELEGRAM.md 3e section (read-only chat, /new keeps proposals, busy/queue/budget replies, possible duplicate reply after ECONNRESET), 3f items; CHAT_DISABLED_REPLY only for the no-onChat path.

# Phase 3e follow-up: Telegram formatting, typing, 👀 reaction (Fable gate)

Gateway commits 5ded228, 56d7611, 4ede91a (round 1); aac1f4c, e247fb8 (round 2). No new dependency (hand-written Markdown→Telegram HTML converter after `marked` could not be installed in the sandbox).

## Round 1: CHANGES REQUESTED
- Blocker: `finalReply` checked for the verbatim preview on untruncated text, then capped at 3800; a long description lost the end of its fence and the "Reply /yes" line, and the preview was not re-appended.
- Major: Telegram entity nesting (pre/code/a can't contain each other; no pre in blockquote) needed modelling.
- Minor: typing max tied to chat timeout; plain fallback keeps URLs; tabs verbatim in fences; fences under list items at 4+ spaces; plain resend only on "can't parse entities"; linear heading/table checks and a 32 KiB parse cap.

## Round 2: APPROVED
All items verified in code and tests (436 tests). Residual minors: preview emitted twice by the model can leave a truncated second copy; a quote group can slightly exceed 3800 (still under 4096); link-scan budget degrades to literal text; delimiter matching O(k²) bounded by 32 KiB. Recommended: a live message confirming Telegram accepts quote+link/code, list+fence, link+bold.

Deployed to cyrus-test at e247fb8 (infra/transcripts/phase-3e-format-install-intake.txt, healthz ok, secret-shape grep 0).

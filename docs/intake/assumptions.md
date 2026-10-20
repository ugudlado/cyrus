# Assumptions and unverified facts

Each entry says what is assumed, where it came from, and how it will be checked. Update the status when verified.

| # | Assumption | Source | Status |
|---|---|---|---|
| 1 | Starting Cyrus from inside a Claude Code session breaks it because inherited `CLAUDECODE*` env vars leak into the runner. | Community reports (PLAN.md §6.5) | Unverified in source. Mitigation regardless: Cyrus only ever runs under systemd as user `cyrus`. |
| 2 | Tests must run with a clean environment; a host `GEMINI_API_KEY` changes the default runner. | `RunnerSelectionService.ts:32-35`, baseline run | Verified (see `baseline.md`). |
| 3 | Linux sandbox prerequisites are exactly `socat`, `bwrap`, and a working `bwrap --unshare-user --unshare-pid --unshare-net` probe; AppArmor profile only where AppArmor is enabled. | `packages/claude-runner/src/sandbox-requirements.ts` at `632128f3` | Verified by reading the source. Probe re-run as user `cyrus` in Phase 1. |
| 4 | Instabox public port URLs wake a paused box and reach `127.0.0.1:<port>`. | Instabox `MACHINE.md` / skill docs | Partly false. While the box runs, the URL reaches `127.0.0.1:3456` (HTTP 200 from the placeholder, ~0.9 s from the laptop). A paused box is **not** woken: it returns 503 "Sandbox offline" until the owner runs `instabox resume`. See PLAN.md §13 A6. |
| 5 | A paused box wakes and answers its first request well inside AgentMail's 5-minute Svix timestamp tolerance, so legitimate deliveries are not rejected as stale. | Phase 0 review security note | Moot on Instabox: a paused box never wakes from a webhook, so there is no wake latency to compare with the 5-minute Svix window. Deliveries made while paused fail. Email is recovered by the catch-up job (3d); Telegram/Linear depend on their own retries. The box must be resumed before E2E runs. |
| 6 | The bwrap probe passes as `cyrus` on any host. | Phase 1 on Instabox | False on hosts that overmount files in `/proc` (Instabox `boot_id`). Passes when started via `/usr/local/libexec/cyrus-run`; Cyrus must always start through it (PLAN.md §13 A6). |

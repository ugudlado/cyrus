# Assumptions and unverified facts

Each entry says what is assumed, where it came from, and how it will be checked. Update the status when verified.

| # | Assumption | Source | Status |
|---|---|---|---|
| 1 | Starting Cyrus from inside a Claude Code session breaks it because inherited `CLAUDECODE*` env vars leak into the runner. | Community reports (PLAN.md §6.5) | Unverified in source. Mitigation regardless: Cyrus only ever runs under systemd as user `cyrus`. |
| 2 | Tests must run with a clean environment; a host `GEMINI_API_KEY` changes the default runner. | `RunnerSelectionService.ts:32-35`, baseline run | Verified (see `baseline.md`). |
| 3 | Linux sandbox prerequisites are exactly `socat`, `bwrap`, and a working `bwrap --unshare-user --unshare-pid --unshare-net` probe; AppArmor profile only where AppArmor is enabled. | `packages/claude-runner/src/sandbox-requirements.ts` at `632128f3` | Verified by reading the source. Probe re-run as user `cyrus` in Phase 1. |
| 4 | Instabox public port URLs wake a paused box and reach `127.0.0.1:<port>`. | Instabox `MACHINE.md` / skill docs | To verify in Phase 1 (placeholder server). |

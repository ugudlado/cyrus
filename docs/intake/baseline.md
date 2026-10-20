# Baseline — upstream Cyrus before fork changes

Recorded 2026-10-21 on the developer's laptop (macOS, Node v24.0.0, pnpm 10.33.1 per `packageManager`).

- Upstream: `cyrusagents/cyrus` at `632128f32a817dd626c2d094c2b6a357afb48522` ("chore: release v0.2.74 (CYPACK-1592) (#1548)"), npm `cyrus-ai@0.2.74`.
- Branch: `feat/telegram-email-intake`, cut from that commit.

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` (`biome check`) | pass (2 pre-existing warnings, "Unexpected template string placeholder") |
| `pnpm -r test:run` (clean env) | pass — 0 failures |

Test counts (clean env):

| Package | Tests |
|---|---|
| packages/cloudflare-tunnel-client | 26 passed |
| packages/mcp-tools | 35 passed |
| packages/core | 193 passed |
| packages/gitlab-event-transport | 11 passed |
| packages/github-event-transport | 117 passed |
| packages/claude-runner | 120 passed |
| packages/linear-event-transport | 31 passed |
| packages/slack-event-transport | 82 passed |
| packages/zulip-event-transport | 25 passed |
| packages/config-updater | 55 passed |
| packages/simple-agent-runner | 24 passed |
| packages/codex-runner | 71 passed |
| packages/cursor-runner | 44 passed |
| packages/gemini-runner | 198 passed, 1 skipped |
| packages/opencode-runner | 32 passed |
| packages/edge-worker | 851 passed, 1 skipped |
| apps/cli | 162 passed |

## Run tests with a clean environment

The first run, in the developer's normal shell, had 8 `edge-worker` failures (`EdgeWorker.runner-selection.test.ts` ×2, `EdgeWorker.screenshot-upload-hooks.test.ts` ×6). Cause: `GEMINI_API_KEY` was set in the shell, and `RunnerSelectionService` (`packages/edge-worker/src/RunnerSelectionService.ts:32-35`) picks Gemini as the default runner when no Claude credential is present. With only `PATH`/`HOME`/`TMPDIR` set, every test passes.

Use this for every later test run so results compare like for like:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" CI=true pnpm -r test:run
```

# Plan amendment A10 (GitHub App) — Fable review, round 3

Date: 2026-10-21. Reviewer: Fable (read-only subagent, resumed with rounds 1–2 context).

## Verdict (verbatim)

```
VERDICT: APPROVED
BLOCKING:
- none
NON-BLOCKING:
- Answer to the specific question, verified in source: yes, all three switch. GitHub: `useSignatureVerification = isExternalHost && hasGithubWebhookSecret` (EdgeWorker.ts:970-976) and `resolveVerification()` re-checks the env on every request (GitHubEventTransport.ts:81-104), then requires `x-hub-signature-256` HMAC over `rawBody` (:166-180). GitLab: same gate (EdgeWorker.ts:1053-1060); "signature" mode is a plain `X-Gitlab-Token === secret` compare (GitLabEventTransport.ts:150-158), which fails closed for a random secret. Slack: `useDirectSlackWebhooks = isExternalHost && hasSlackSigningSecret` (EdgeWorker.ts:1305-1313); direct mode requires timestamp (5-min window) + `v0=` HMAC over `rawBody` with `timingSafeEqual` before any JSON handling (SlackEventTransport.ts:162-235), and the `url_verification` challenge is only answered after verification (:282-285). No other code reads these three names (grep over packages/apps), so no feature is switched on by their presence.
- A9:388 still calls `/etc/cyrus/cyrus.env` the "non-secret settings" file; after A10 §6 it holds three generated secrets on disk (not tmpfs, so they are in snapshots). Update that bullet and A9:403, and add a rotation line: delete the three lines and re-run `install-cyrus.sh` (or `openssl rand -hex 32` via `sudoedit`), then `systemctl restart cyrus`.
- Implementation follow-through for the step that lands this: `install-cyrus.sh:217-218` still lists `GITHUB_TOKEN CYRUS_API_KEY` as required for `cyrus` and :120 still writes the provisional `gh auth git-credential` helper; the Phase 2 transcript must show the new bridge table and the helper removal (`git config --global --get-all credential.https://github.com.helper` as `cyrus` prints nothing).
- Generate the three values with shell builtins only (`v=$(openssl rand -hex 32); printf '%s=%s\n' NAME "$v" >> file`); `printf` is a builtin so the value never appears in `/proc/*/cmdline`, consistent with A10's no-argv rule. Say so in A10 §6.
- Pre-existing, not A10-specific, but worth a Phase 2 check: direct/signature modes pass `ipAllowlist` when `webhookIpValidator.isEnabled()` (EdgeWorker.ts:859-862, 985-988). Behind Instabox-terminated HTTPS `request.ip` is the ingress proxy unless Fastify trusts `X-Forwarded-For`; confirm the validator's default on the box so legitimate Linear webhooks are not rejected with 403, and record the setting.
- A10 §3's `Environment=PATH=` must also apply to the `systemd-run` invocation in `cyrus-admin` (A9) so `self-add-repo`'s `git clone`/`gh repo clone` use the wrapper and helper; A10 names `cyrus-admin` but A9:392 does not mention PATH.
SECURITY NOTES:
- Putting `GITHUB_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET` and `SLACK_SIGNING_SECRET` in `cyrus.service`'s environment does expose them to sessions (session-env.ts:54-56). What a holder can do: forge a signed `/github-webhook` PR-comment event for `cyrus-sandbox-app` (starts a session), a `/gitlab-webhook` event (no repo configured → ignored), or, once a real Slack secret is present, Slack events (chat sessions). That is strictly less than what `CYRUS_API_KEY` in the same environment allowed (config/repository rewrites), and it is the same exposure class as `LINEAR_WEBHOOK_SECRET` and `LINEAR_CLIENT_SECRET`, which already sit there. Using it from inside a session needs a route to the published URL, which the trusted egress preset denies (the Instabox hostname is not in `TRUSTED_DOMAINS`), so it requires exfiltration plus a published port; the "3456 unpublished outside test windows" rule is the control. Record this as accepted exposure in A10 alongside the write token.
- If M later configures real GitHub or Slack webhooks, those real secrets inherit the same session exposure; note it in the Phase 5 runbook.
- With all three transports in signature/direct mode and `CYRUS_API_KEY` unset, the only unauthenticated endpoint left on 3456 while a session runs is `/mcp/cyrus-tools` (context-id gated, McpConfigService.ts:220-239), which A10's acceptance now probes and the unpublish rule covers; the `/api/update/*` family is fully closed (ConfigUpdater.ts:181-189).
- Round 2's `/run` readability and `includeIf` resolved-path concerns are now acceptance items with a named fallback (`/var/lib/gh-token` tmpfs); no change to the trust boundary: `root:cyrus 0640` keeps `intake` out, `/run/ghapp` stays root-only, and the private key never touches disk.
```

## Disposition

All NON-BLOCKING items applied in PLAN.md:
- A10 §6: builtin-only generation, a rotation line, and the accepted exposure.
- A9: settings-file wording, and `cyrus-admin` PATH.
- Acceptance: the webhook IP validation check, the infra follow-through, and the helper removal.

A10 is approved.

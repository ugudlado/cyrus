# Phase 1 — Fable review, round 1

Date: 2026-10-21. Reviewer: Fable (read-only subagent, PLAN.md §9 / §13 A3).

## Evidence (verbatim)

```
public URL from laptop: HTTP 200 in 0.977738s
body: cyrus placeholder
placeholder pid 8101: USER cyrus GROUP cyrus
Uid:	1001	1001	1001	1001
Gid:	1001	1001	1001	1001
CapEff:	0000000000000000
CapBnd:	0000000000000000
NoNewPrivs:	1
mountns differs from host: yes
boot_id overmount inside service ns: 0
boot_id overmount on host: 1
sudo -l -U cyrus: User cyrus is not allowed to run sudo on instabox-cyrus-test.
rerun exit=0 in 9s
cyrus.env before: 1792529662 0 root:cyrus 640
cyrus.env after:  1792529662 0 root:cyrus 640
suspend → public URL: HTTP/2 503 "Sandbox offline. Its owner must start it to use this URL." (~0.85s); Paused for 2 min of 10s polling; `instabox wake` refused; `instabox resume` → HTTP 200
```

### After review fixes

Run on the box after re-provisioning (`provision.sh: done (instabox)`, also on two further runs; the Claude Code install was skipped by the marker). `grep -c boot_id /proc/self/mountinfo` printed 0 here because of an incident, not because the host changed by itself: see "Incident" below.

```
2.1.305 (Claude Code)
v24.22.0
gh version 2.102.1 (2026-10-20)
-rw-r--r-- 1 root root 0 Oct 20 21:06 /opt/node/.claude-code-2.1.305-postinstall
uid=1001(cyrus) gid=1001(cyrus) groups=1001(cyrus)
cyrus-run: refusing to unmount in the host mount namespace
direct-inner exit=1
0
Uid:	1001	1001	1001	1001
Gid:	1001	1001	1001	1001
CapEff:	0000000000000000
CapBnd:	0000000000000000
NoNewPrivs:	1
root:cyrus 640 0
cyrus placeholder
 HTTP 200
```

### Incident: host `boot_id` overmount removed during verification, then restored

The first version of the A3 guard compared mount namespaces with `[[ $(readlink A) != $(readlink B) ]]`. The unquoted right-hand side is a glob pattern, and `mnt:[4026531832]` is a bracket expression, so the test always passed. While verifying, the executor ran `sudo env CYRUS_RUN_IN_NS=1 cyrus-run cyrus true` (expected to be refused). The broken guard let it run in the **host** mount namespace, and it unmounted Instabox's `/proc/sys/kernel/random/boot_id` overmount on the host. Later provisioning runs then reported "file overmounts under /proc on this host: none".

The guard was fixed by quoting the right-hand side. The parent then restored the host mount from its source and re-verified with the overmount present:

```
$ sudo mount --bind /run/instabox/boot-id /proc/sys/kernel/random/boot_id && grep boot_id /proc/self/mountinfo
46 24 0:25 /instabox/boot-id /proc/sys/kernel/random/boot_id rw,nosuid,nodev shared:12 - tmpfs tmpfs rw,size=1631116k,nr_inodes=819200,mode=755
host boot_id now: 5718ccc3-7617-8e54-fd5a-18a44f3a76f2 (instabox file: 5718ccc3-7617-8e54-fd5a-18a44f3a76f2)
--- probe via cyrus-run under systemd
PROBE_OK
--- guard
cyrus-run: refusing to unmount in the host mount namespace
direct-inner exit=1
1
```

The mount ID, source and flags match the original (`46 24 0:25 /instabox/boot-id … rw,nosuid,nodev shared:12`). Lesson: a guard must be shown to refuse before it is trusted, and a test of "must refuse" runs only after the refusal path is reviewed.

## Verdict

```
VERDICT: APPROVED
BLOCKING:
- none
NON-BLOCKING:
- [infra/provision.sh:129-135] HARDEN_NETWORK=yes path (unexecuted): ufw allows `$SSH_PORT/tcp` but the sshd drop-in (lines 118-123) never sets `Port`, so a profile with SSH_PORT!=22 locks the operator out at `ufw --force enable`. Before the first VPS run: either write `Port $SSH_PORT` into the drop-in, or (safer) read the live port with `sshd -T | awk '$1=="port"{print $2}'` and die if it differs from SSH_PORT.
- [infra/provision.sh:75] arm64 always dies, even when the profile sets NODE_SHA256 (the message says the opposite). Only die when NODE_ARCH!=x64 AND NODE_SHA256 is still the x64 default.
- [infra/provision.sh:243-247] `--in-ns` sentinel is a positional arg. Running `cyrus-run --in-ns cyrus …` by hand as root skips `unshare` and would umount the boot_id overmount on the HOST namespace. Use a private env marker set only by the outer `exec` (e.g. `CYRUS_RUN_NS=1 exec unshare …`), or verify with `readlink /proc/self/ns/mnt` vs `/proc/1/ns/mnt` before unmounting.
- [infra/provision.sh:360-367] After Phase 2 enables `cyrus.service` the placeholder stays enabled; `Conflicts=` only resolves at runtime, so boot ordering becomes racy. In the else-branch run `systemctl disable --now cyrus-placeholder`. Phase 2 must do the same when it installs `cyrus.service`.
- [infra/provision.sh:178] First transcript: npm skipped `@anthropic-ai/claude-code` postinstall (`install.cjs`) under the new allowScripts policy. `claude --version` works, so acceptance is met, but the skipped script may be what stages the native binary; a first real session as cyrus could try to download it at runtime. Either add `--allow-scripts=@anthropic-ai/claude-code` to the install line (note `npm_global_has` will not re-run it; uninstall once), or make "a real `claude -p` session under cyrus-run" an explicit Phase 2 check.
- [infra/provision.sh:195] `DISABLE_AUTOUPDATER=1` lives only in `.profile`; systemd units do not source it. Phase 2 `cyrus.service` must set `Environment=PATH=<SERVICE_PATH> DISABLE_AUTOUPDATER=1` explicitly (the placeholder unit already sets PATH this way).
- [infra/provision.sh:373-374] ANTHROPIC_API_KEY check does not look in `$SERVICE_HOME/.claude/settings.json`, `$SERVICE_HOME/.claude.json` or `$SERVICE_HOME/.npmrc`; add them (Claude Code reads `env`/`apiKeyHelper` from settings).
- [infra/provision.sh:386] `ss -Hltn` lists TCP only; use `ss -Hltun` so the Instabox acceptance ("no listener other than sshd and 127.0.0.1:3456") also covers UDP.
- Acceptance literally says `sudo -u cyrus claude --version`; the proof is `runuser -l cyrus`, which is the correct semantics (login PATH). Either record the equivalent command (`sudo -u cyrus -i claude --version`) in README/A6, or symlink node/npm/claude/pnpm from /opt/node/current/bin into /usr/local/bin so the literal command also works under sudo's secure_path.
- Evidence hygiene: the public-URL 200 check, the process credential dump (Uid/Gid/CapEff/NoNewPrivs) and the idempotency stat lines are in the prompt, not in a transcript. Paste them verbatim into docs/reviews/phase-1-round-1.md so the record is self-contained.
- [PLAN.md:280] A2 still says "wakes on a request to its public URL … Webhooks therefore wake it"; A6 (line 292) and assumptions.md #4/#5 say the opposite. Strike or annotate the A2 sentence so the plan does not contradict itself.
- Open question (a): cyrus-run is sound and not weaker than `User=cyrus`. Evidence: Uid/Gid 1001 x4, CapEff=CapBnd=0, NoNewPrivs=1, supplementary groups only cyrus, host overmount untouched; the exec chain (unshare → $0 → setpriv → cmd) keeps the real process as MainPID so stop/restart signals work. Differences to know: ExecStartPre/Post and `%h`-style specifiers would resolve as root; the service lives in a private mount ns, so mounts made on the host after start are invisible to it; and the real host boot_id is visible inside the service ns (Instabox hides it deliberately; fingerprint-only, acceptable). The `--in-ns` footgun above is the only thing to tighten.
- Open question (b): acceptable for a TEST environment; nothing in Phase 1 depends on wake-up. Phase 2/4 must: (1) resume the box and assert the public URL returns 200, not 503, before any webhook-driven step; (2) raise the idle timeout (`instabox timeout`) for E2E windows; (3) not assume sender retry behaviour — in Phase 4 send one event per channel (Linear, Slack, Telegram, AgentMail) while paused, resume, and record what arrives; (4) keep the 3d email catch-up job as a hard requirement; (5) note it is Instabox-only; Contabo is unaffected.
- Open question (c): nothing blocks Phase 2. Carry these into Phase 2: ExecStart via cyrus-run with no `User=`; disable the placeholder; Environment= as above; `defaultRunner: "claude"` (A5); and resolve the bind-address conflict in the security notes below.
SECURITY NOTES:
- No secret values in provision.sh, run-on.sh, profiles, README, the three transcripts, PLAN.md or the review/assumptions docs; the summary prints key names only. /etc/cyrus is root:cyrus 0750, cyrus.env root:cyrus 0640 (created once, never rewritten; stat identical across runs), cloudflared.env root:root 0600. Profile guard (lines 53-61) is allowlist-first with a secret-name refusal on top and a strict value charset, and `printf -v` only ever assigns allowlisted names; the six parser cases in the prompt confirm it. run-on.sh ships only provision.sh + profile.env and runs `sudo env -i PATH=…`, so no laptop env (including the known GEMINI_API_KEY) can reach the host.
- The bwrap probe (line 263) is byte-for-byte the argv in sandbox-requirements.ts:176-190, run as cyrus under systemd through the same launcher the service will use. Root cause (file overmount on /proc/sys/kernel/random/boot_id) is well diagnosed; the fix stays inside the service's mount namespace and the host overmount remains.
- cyrus is removed from sudo/wheel/admin/docker and has no sudoers entry (`sudo -l -U cyrus` denies); docker-ce IS installed on this image, so keeping cyrus out of the `docker` group (equivalent to root) matters — the script does that on every run.
- Phase 2 conflict with A5 "Cyrus binds 127.0.0.1:3456 only": upstream binds `0.0.0.0` whenever `CYRUS_HOST_EXTERNAL=true` (apps/cli/src/services/WorkerService.ts:110, :269; EdgeWorker.ts:482 falls back to "localhost"), and that flag is also what enables direct Linear OAuth (SharedApplicationServer.ts:318-329), direct GitHub signature verification (EdgeWorker.ts:964-971), webhook IP validation (EdgeWorker.ts:464-467) and self-hosted Slack (PLAN §6.6). Phase 2 must choose explicitly: run with CYRUS_HOST_EXTERNAL unset where the flow allows it, or accept 0.0.0.0 behind the platform/ufw and record it as a deviation, with a bind-host override added as a small Phase 3 fork change. Do not let it slip in silently.
- With CYRUS_HOST_EXTERNAL=true, WebhookIpValidator is on by default and Fastify runs with `trustProxy: true` (SharedApplicationServer.ts:82), so correctness depends on the fronting proxy (Instabox, Caddy, cloudflared) setting X-Forwarded-For honestly and stripping client-supplied values. Verify on Instabox in Phase 2 before trusting it; `WEBHOOK_IP_VALIDATION=false` is the documented escape hatch, not a default.
- The published URL `https://3456-…instabox.tech` is "anyone can reach" and is now committed in PLAN.md A6 and the transcripts. Fine for a placeholder, and all Cyrus webhook routes are signature-verified, but treat it as public: unpublish it when not testing and never put unauthenticated endpoints behind it.
- Unit hardening for Phase 2 (suggestion, not a finding): `cyrus.service` can still carry `PrivateTmp=yes`, `ProtectKernelTunables=yes`, `ProtectControlGroups=yes`, `RestrictSUIDSGID=yes` alongside cyrus-run; avoid `ProtectProc=`/`ProcSubset=` (shown not to help) and anything that re-mounts /proc.
- Allowlist-in-code, raw-body webhook verification, Linear-write isolation and transport regressions are not applicable to Phase 1; checked from 3a onward.
```

## Disposition

| Item | Action |
|---|---|
| SSH port guard | `provision.sh` dies before enabling ufw if `sshd -T` port differs from `SSH_PORT`. |
| arm64 | Dies only when `NODE_ARCH` is not x64 and `NODE_SHA256` is still the x64 default. |
| cyrus-run sentinel | Positional `--in-ns` replaced by `CYRUS_RUN_IN_NS`, unset on entry; inner path refuses to unmount unless the mount namespace differs from PID 1's. |
| placeholder disable | When `cyrus.service` is enabled, `cyrus-placeholder` is disabled and stopped. |
| Claude postinstall | Installed with `--allow-scripts=@anthropic-ai/claude-code`, gated on a per-version marker file. |
| API key check paths | Also scans `~/.claude/settings.json`, `~/.claude.json`, `~/.npmrc`, and matches `apiKeyHelper`. |
| UDP listeners | Listener summary uses `ss -Hltun` and prints the protocol. |
| sudo -u wording (README) | README documents `sudo -u cyrus -i claude --version` and the cyrus-run-only start rule. |
| evidence hygiene (this file) | Raw evidence and post-fix outputs recorded verbatim here. |
| A2 contradiction | PLAN §13 A2 bullet annotated "Disproved in Phase 1 — see A6"; original text kept. |
| bind address / XFF / unit hardening / paused box / defaultRunner | Carried to Phase 2 as PLAN §13 A7. |
| public URL exposure | Unpublish the port when not testing (A7). |

---
name: kittu-setup-launch
description: Print a summary of the Kittu setup and offer to start the agent.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.kittu/.env` or any file inside `~/.kittu/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Launch

Prints a summary of the completed setup and offers to start Kittu.

## Step 1: Gather Configuration

Read current state:

```bash
# Base URL
grep '^KITTU_BASE_URL=' ~/.kittu/.env 2>/dev/null | cut -d= -f2-

# Linear
grep -c '^LINEAR_CLIENT_ID=' ~/.kittu/.env 2>/dev/null

# GitHub
gh auth status 2>&1 | head -1

# Slack
grep -c '^SLACK_BOT_TOKEN=' ~/.kittu/.env 2>/dev/null

# Repositories
cat ~/.kittu/config.json 2>/dev/null

# Claude auth
grep -c -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' ~/.kittu/.env 2>/dev/null
```

## Step 2: Print Summary

Print a formatted summary:

```
┌─────────────────────────────────────┐
│         Kittu Setup Complete        │
├─────────────────────────────────────┤
│                                     │
│  Endpoint: https://your-url.com     │
│  Claude:   ✓ API key configured     │
│                                     │
│  Surfaces:                          │
│    Linear:  ✓ Workspace connected   │
│    GitHub:  ✓ CLI authenticated     │
│    Slack:   ✓ Bot configured        │
│                                     │
│  Repositories:                      │
│    • yourorg/yourrepo               │
│    • yourorg/another-repo           │
│                                     │
└─────────────────────────────────────┘
```

Use ✓ for configured items and ✗ for skipped/unconfigured items.

## Step 3: Make Kittu Persistent

Kittu needs to run as a background process so it stays alive and restarts after reboots. **Use the `AskUserQuestion` tool if available** to ask:

> **How would you like to keep Kittu running in the background?**
>
> 1. **pm2** (recommended) — Node.js process manager. Simple to set up, auto-restarts on crash, log management built in. Best for most users.
> 2. **systemd** (Linux only) — OS-level service manager. Starts on boot automatically, managed with `systemctl`. Best for dedicated Linux servers.
> 3. **Neither** — just run `kittu` in the foreground for now (you can set up persistence later).

### Option 1: pm2

The agent should run all of these commands directly:

1. Check if pm2 is installed (`which pm2`). If not, install it (`npm install -g pm2`).
2. Start Kittu: `pm2 start kittu --name kittu`
3. Save the process list: `pm2 save`
4. Run `pm2 startup` — this prints a system-specific command. The agent should run that output command too (it typically requires `sudo`).

After setup, inform the user of useful commands:
- `pm2 logs kittu` — view logs
- `pm2 restart kittu` — restart
- `pm2 stop kittu` — stop

### Option 2: systemd (Linux only)

The agent should run all of these commands directly:

1. Resolve the actual values for the service file:
   ```bash
   KITTU_BIN=$(which kittu)
   KITTU_USER=$(whoami)
   ```

2. Write the service file:
   ```bash
   sudo tee /etc/systemd/system/kittu.service > /dev/null << EOF
   [Unit]
   Description=Kittu AI Agent
   After=network.target

   [Service]
   Type=simple
   User=$KITTU_USER
   EnvironmentFile=/home/$KITTU_USER/.kittu/.env
   ExecStart=$KITTU_BIN
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   EOF
   ```

3. Enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable kittu
   sudo systemctl start kittu
   ```

After setup, inform the user of useful commands:
- `sudo systemctl status kittu` — check status
- `sudo journalctl -u kittu -f` — view logs
- `sudo systemctl restart kittu` — restart

### Option 3: Foreground

Run directly:

```bash
kittu
```

## Step 4: Start ngrok (if applicable)

If the user configured ngrok in the endpoint step, the agent should start it:

```bash
ngrok start kittu
```

If using pm2, also make ngrok persistent:

```bash
pm2 start "ngrok start kittu" --name ngrok
pm2 save
```

## Step 5: Sandbox CA Certificate Trust (if sandbox enabled)

If the user's `~/.kittu/config.json` has `sandbox.enabled: true`, check whether the egress proxy CA certificate is trusted in the system keychain.

**Check if sandbox is enabled:**

```bash
grep -o '"enabled":\s*true' ~/.kittu/config.json 2>/dev/null | head -1
```

If sandbox is enabled, check trust status:

```bash
# macOS — check System keychain for the Kittu CA
security find-certificate -c "Kittu Egress Proxy CA" /Library/Keychains/System.keychain 2>&1
```

- If the cert is found (exit code 0): report ✓ trusted. Offer to set `sandbox.systemWideCert: true` in config.json to skip per-session cert env vars.
- If not found (exit code 44): inform the user and offer to run the trust command:

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.kittu/certs/kittu-egress-ca.pem
```

On Linux, check with `test -f /usr/local/share/ca-certificates/kittu-egress-ca.crt`. If not present:

```bash
sudo cp ~/.kittu/certs/kittu-egress-ca.pem /usr/local/share/ca-certificates/kittu-egress-ca.crt
sudo update-ca-certificates
```

After trusting system-wide, offer to set `sandbox.systemWideCert: true` in config.json. This skips per-session cert env vars (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, etc.) since the OS cert store handles trust for all tools.

If the user declines system-wide trust, Kittu still works — it sets cert env vars per-session. But some tools (Bun, .NET, curl on macOS with SecureTransport) will only work with system-wide trust.

## Step 6: Verify Running

Once Kittu starts, verify it's listening:

```bash
curl -s http://localhost:3456/status
```

Should return `{"status":"idle"}` or similar.

> Then try assigning a Linear issue to Kittu, or @mentioning it in Slack, to verify the full pipeline works!

## Completion

> ✓ Kittu is running and ready. Assign a Linear issue or @mention in Slack to test it out!

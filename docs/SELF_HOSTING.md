# End-to-End Self-Hosting Guide

## Quick Start (Recommended)

If you're using any AI coding agent (Claude Code, Codex, Cursor, etc.), set up Kittu with a single command:

```bash
npx skills add ugudlado/kittu -g
```

Then in your agent:

```
/kittu-setup
```

The setup skill walks you through everything below — automatically.

---

## Manual Setup

This guide walks you through setting up Kittu completely self-hosted, including your own Linear OAuth application. This is the free, zero-cost option that gives you full control.

---

## Prerequisites

- **Linear workspace** with admin access (required to create OAuth apps)
- **Node.js** v18 or higher
- **jq** (for Claude Code parsing)
- **A public URL** for receiving Linear webhooks

### Install Dependencies

**macOS:**
```bash
brew install jq gh

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v18 or higher
```

**Linux/Ubuntu:**
```bash
apt install -y gh npm git jq

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v18 or higher
```

---

## Overview

You'll complete these steps:

1. Set up a public URL for webhooks
2. Configure Claude Code authentication
3. Create a Linear OAuth application
4. Install Kittu and complete your environment file
5. Start Kittu, authorize with Linear, and add repositories

> **Tip:** Kittu automatically loads environment variables from `~/.kittu/.env` on startup. You can override this path with `kittu --env-file=/path/to/your/env`.

---

## Step 1: Set Up Public URL

Linear needs to send webhooks to your Kittu instance. Choose one option:

| Option | Best For | Persistence |
|--------|----------|-------------|
| [Cloudflare Tunnel](./CLOUDFLARE_TUNNEL.md) | Production | Permanent URL |
| ngrok | Development/testing | Free static domain included |
| Public server/domain | VPS or cloud hosting | Permanent URL |
| Reverse proxy (nginx/caddy) | Existing infrastructure | Permanent URL |

You'll need:
- A public URL (e.g., `https://kittu.yourdomain.com`)
- The URL must be accessible from the internet

---

## Step 2: Configure Claude Code Authentication

Kittu needs Claude Code credentials. Choose one option and add it to your env file (`~/.kittu/.env`):

**Option A: API Key** (recommended)
```bash
ANTHROPIC_API_KEY=your-api-key
```
Get your API key from the [Anthropic Console](https://console.anthropic.com/).

**Option B: OAuth Token** (for Max subscription users)

Run `claude setup-token` on any machine where you already have Claude Code installed (e.g., your laptop), then add to your env file:
```bash
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token
```

**Option C: Third-Party Providers**

For Vertex AI, Azure, AWS Bedrock, and other providers, see the [Third-Party Integrations](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex) documentation.

---

## Step 3: Create Linear OAuth Application

**IMPORTANT:** You must be a **workspace admin** in Linear.

### 3.1 Open Linear Settings

1. Go to Linear: https://linear.app
2. Click your workspace name (top-left corner)
3. Click **Settings** in the dropdown
4. In the left sidebar, scroll down to **Account** section
5. Click **API**
6. Scroll down to **OAuth Applications** section

### 3.2 Create New Application

1. Click **Create new OAuth Application** button

2. Fill in the form:
   - **Name:** `Kittu`
   - **Description:** `Self-hosted Kittu agent for automated development`
   - **Callback URLs:** `https://your-public-url.com/callback`

3. **Enable Client credentials** toggle

4. **Enable Webhooks** toggle

5. **Configure Webhook Settings:**
   - **Webhook URL:** `https://your-public-url.com/linear-webhook`
   - **App events** - Check these boxes:
     - **Agent session events** (REQUIRED - makes Kittu appear as agent)
     - **Inbox notifications** (recommended)
     - **Permission changes** (recommended)

6. Click **Save**

### 3.3 Copy OAuth Credentials

After saving, copy these values:

1. **Client ID** - Long string like `client_id_27653g3h4y4ght3g4`
2. **Client Secret** - Another long string (may only be shown once!)
3. **Webhook Signing Secret** - Found in webhook settings

### 3.4 Add to Environment File

Add these to your env file (`~/.kittu/.env`):

```bash
# Linear OAuth configuration
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=client_id_27653g3h4y4ght3g4
LINEAR_CLIENT_SECRET=client_secret_shgd5a6jdk86823h
LINEAR_WEBHOOK_SECRET=lin_whs_s56dlmfhg72038474nmfojhsn7
```

---

## Step 4: Install and Configure Kittu

### 4.1 Install Kittu

```bash
npm install -g kittu-ai
```

### 4.2 Complete Your Environment File

Your env file (`~/.kittu/.env`) should now contain:

```bash
# Server configuration
LINEAR_DIRECT_WEBHOOKS=true
KITTU_BASE_URL=https://your-public-url.com
KITTU_SERVER_PORT=3456

# Linear OAuth
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=your_webhook_secret

# Claude Code authentication (choose one)
ANTHROPIC_API_KEY=your-api-key
# or: CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token

# Optional: Cloudflare Tunnel
# CLOUDFLARE_TOKEN=your-cloudflare-token
```

---

## Step 5: Authorize and Add Repositories

### 5.1 Authorize with Linear

```bash
kittu self-auth-linear
```

This will:
1. Start a temporary OAuth callback server
2. Open your browser to Linear's OAuth authorization page
3. After you click **Authorize**, redirect back and save the tokens to your config

### 5.2 Add a Repository

```bash
kittu self-add-repo https://github.com/yourorg/yourrepo.git
```

This clones the repository to `~/.kittu/repos/` and configures it with your Linear workspace credentials.

For multiple workspaces, specify which one:
```bash
kittu self-add-repo https://github.com/yourorg/yourrepo.git "My Workspace"
```

You can run `kittu self-add-repo` at any time, even while Kittu is running. No restart is required—Kittu will automatically pick up the new repository configuration.

### 5.3 Start Kittu

Once authorization is complete and repositories are added, start Kittu:

```bash
kittu
```

Kittu automatically loads `~/.kittu/.env` on startup. You'll see Kittu start up and show logs.

> **Note:** To use a different env file location, use `kittu --env-file=/path/to/your/env`.

---

## Step 6: Set Up GitHub (Optional)

For Kittu to create pull requests, configure Git and GitHub CLI authentication.

See the **[Git & GitHub Setup Guide](./GIT_GITHUB.md)** for complete instructions.

---

## Running as a Service

For 24/7 availability, run Kittu as a persistent process.

### Using tmux

```bash
tmux new-session -s kittu
kittu
# Ctrl+B, D to detach
# tmux attach -t kittu to reattach
```

### Using pm2

```bash
pm2 start kittu --name kittu
pm2 save
pm2 startup
```

### Using systemd (Linux)

Create `/etc/systemd/system/kittu.service`:

```ini
[Unit]
Description=Kittu AI Agent
After=network.target

[Service]
Type=simple
User=your-user
EnvironmentFile=/home/your-user/.kittu/.env
ExecStart=/usr/local/bin/kittu
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable kittu
sudo systemctl start kittu
```

---

## Configuration

Kittu stores its configuration in `~/.kittu/config.json`. You can customize tool permissions, issue routing rules, MCP server integrations, and label-based AI modes by editing this file. Kittu watches the config file and automatically picks up changes—no restart required.

For detailed options, see the [Configuration File Reference](./CONFIG_FILE.md).

---

## Troubleshooting

### OAuth Authorization Fails

- Verify `KITTU_BASE_URL` matches your Linear OAuth callback URL exactly
- Check that your public URL is accessible from the internet
- Ensure all Linear environment variables are set

### Webhooks Not Received

- Verify Linear webhook URL matches `KITTU_BASE_URL/linear-webhook` (the legacy `/webhook` path still works but is deprecated)
- Check Kittu logs for incoming webhook attempts
- Ensure your public URL is accessible

### Repository Not Processing

- Check that the repository is in your config (`~/.kittu/config.json`)
- Verify Linear tokens are valid with `kittu check-tokens`
- Ensure the issue is assigned to Kittu in Linear

### Claude Code Not Working

- Verify your Claude Code credentials are set in the env file
- For API key: Check it's valid at [console.anthropic.com](https://console.anthropic.com/)
- For OAuth token: Run `claude setup-token` again to refresh

---

## Development Mode

If you're developing Kittu from source:

```bash
cd /path/to/kittu
pnpm install

cd apps/cli
pnpm link --global

# In a separate terminal
pnpm dev

# Then run kittu normally
kittu
```

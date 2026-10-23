---
name: kittu-setup-endpoint
description: Configure the public webhook endpoint for Kittu — ngrok, Cloudflare Tunnel, or custom URL.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.kittu/.env` or any file inside `~/.kittu/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Endpoint

Configures a public URL so Linear (and other integrations) can send webhooks to your Kittu instance.

## Step 1: Check Existing Configuration

```bash
grep -E '^KITTU_BASE_URL=' ~/.kittu/.env 2>/dev/null
```

If `KITTU_BASE_URL` is already set, inform the user:

> Webhook endpoint already configured: `<value>`
> To reconfigure, remove `KITTU_BASE_URL` from `~/.kittu/.env` and re-run this skill.

Skip to Step 4 (write port/webhooks if missing).

## Step 2: Choose Endpoint Method

Ask the user:

> **How will you expose Kittu to the internet for webhooks?**
>
> 1. **ngrok** (recommended — every free account includes one static domain that persists across restarts)
> 2. **Cloudflare Tunnel** (permanent, requires Cloudflare account)
> 3. **Own URL** (you already have a public URL/domain)

**Important:** ngrok's free tier includes a permanent static domain — do NOT tell the user this is a paid feature or that URLs change on restart. Every free ngrok account gets one static domain at https://dashboard.ngrok.com/domains.

## Step 3: Configure Endpoint

### Option 1: ngrok

#### 3a. Check if ngrok is installed

```bash
which ngrok
```

If not installed, provide install instructions:

**macOS:**
```bash
brew install ngrok
```

**Linux:**
```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok-v3-stable-linux-amd64.tgz | sudo tar xvz -C /usr/local/bin
```

#### 3b. Guide ngrok domain setup

Instruct the user:

> ngrok provides a free static domain so your URL doesn't change between restarts.
>
> 1. Sign up or log in at https://dashboard.ngrok.com
> 2. Go to https://dashboard.ngrok.com/domains
> 3. Copy your free static domain (e.g., `your-name-here.ngrok-free.app`)
> 4. Go to https://dashboard.ngrok.com/get-started/your-authtoken and copy your authtoken

Ask the user to provide:
- Their ngrok domain
- Their ngrok authtoken

**CRITICAL: The authtoken is a secret. Use clipboard-to-file commands.**

#### 3c. Write ngrok configuration

Write the ngrok config so it can be started with `ngrok start kittu`:

```bash
mkdir -p ~/.config/ngrok
```

Then write `~/.config/ngrok/ngrok.yml` (merge with existing if present):

```yaml
version: 3
agent:
  authtoken: <token>
endpoints:
  - name: kittu
    url: <domain>
    upstream:
      url: 3456
```

For the authtoken, use a clipboard-to-file approach:

**macOS:**
```bash
# User copies authtoken, then runs:
NGROK_TOKEN=$(pbpaste) && cat > ~/.config/ngrok/ngrok.yml << EOF
version: 3
agent:
  authtoken: $NGROK_TOKEN
endpoints:
  - name: kittu
    url: <domain>
    upstream:
      url: 3456
EOF
```

**Universal fallback:**
```bash
read -s -p "Paste your ngrok authtoken: " NGROK_TOKEN && cat > ~/.config/ngrok/ngrok.yml << EOF
version: 3
agent:
  authtoken: $NGROK_TOKEN
endpoints:
  - name: kittu
    url: <domain>
    upstream:
      url: 3456
EOF
echo " ✓ Saved"
```

#### 3d. Write KITTU_BASE_URL

```bash
printf 'KITTU_BASE_URL=https://%s\n' "<domain>" >> ~/.kittu/.env
```

Where `<domain>` is the ngrok domain the user provided (e.g., `your-name-here.ngrok-free.app`).

Inform the user:

> To start ngrok, run: `ngrok start kittu`
> Run this in a separate terminal before starting Kittu.

### Option 2: Cloudflare Tunnel

Ask the user for:
- Their Cloudflare Tunnel token
- Their tunnel hostname (e.g., `kittu.yourdomain.com`)

**Token is a secret — use clipboard-to-env:**

**macOS:**
```bash
printf 'CLOUDFLARE_TOKEN=%s\n' "$(pbpaste)" >> ~/.kittu/.env
```

**Universal fallback:**
```bash
read -s -p "Paste your Cloudflare token: " val && printf 'CLOUDFLARE_TOKEN=%s\n' "$val" >> ~/.kittu/.env && echo " ✓ Saved"
```

Then write the base URL (not a secret — agent can write directly):

```bash
printf 'KITTU_BASE_URL=https://<hostname>\n' >> ~/.kittu/.env
```

### Option 3: Own URL

Ask the user for their URL. Validate it starts with `https://`.

```bash
printf 'KITTU_BASE_URL=%s\n' "<url>" >> ~/.kittu/.env
```

## Step 4: Write Common Config

Ensure these are present in `~/.kittu/.env` (add only if missing):

```bash
grep -q '^KITTU_SERVER_PORT=' ~/.kittu/.env 2>/dev/null || printf 'KITTU_SERVER_PORT=3456\n' >> ~/.kittu/.env
grep -q '^LINEAR_DIRECT_WEBHOOKS=' ~/.kittu/.env 2>/dev/null || printf 'LINEAR_DIRECT_WEBHOOKS=true\n' >> ~/.kittu/.env
grep -q '^KITTU_HOST_EXTERNAL=' ~/.kittu/.env 2>/dev/null || printf 'KITTU_HOST_EXTERNAL=true\n' >> ~/.kittu/.env
```

`LINEAR_DIRECT_WEBHOOKS=true` enables direct Linear webhook signature verification. `KITTU_HOST_EXTERNAL=true` enables direct Slack and GitHub webhook signature verification. Both are required for self-hosted setups where webhooks come directly from the services (not forwarded through CYHOST).

## Completion

> ✓ Webhook endpoint configured: `<KITTU_BASE_URL>`
> ✓ Server port: 3456
> ✓ Direct webhooks: enabled

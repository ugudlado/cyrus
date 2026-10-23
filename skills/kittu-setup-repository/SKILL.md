---
name: kittu-setup-repository
description: Add one or more Git repositories to Kittu configuration so it can process issues from those repos.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.kittu/.env` or any file inside `~/.kittu/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Repository

Adds Git repositories to Kittu so it knows which codebases to work with.

## Step 1: Check Existing Repositories

```bash
cat ~/.kittu/config.json 2>/dev/null | grep -o '"url"' | wc -l
```

If repositories are already configured, list them:

```bash
cat ~/.kittu/config.json 2>/dev/null
```

Inform the user which repos are already added.

## Step 2: Add a Repository

Ask the user:

> **What is the Git URL of the repository you want Kittu to work with?**
> (e.g., `https://github.com/yourorg/yourrepo.git`)

Run:

```bash
kittu self-add-repo <url>
```

This clones the repo to `~/.kittu/repos/` and registers it with the Linear workspace.

If multiple workspaces are configured, ask which workspace to use:

```bash
kittu self-add-repo <url> "<workspace name>"
```

Verify the repo was added:

```bash
cat ~/.kittu/config.json | grep "<repo-name>"
```

## Step 3: Add More?

Ask the user:

> **Would you like to add another repository?** (y/n)

If yes, repeat Step 2. If no, continue.

## Completion

> ✓ Repository added: `<url>`
> (repeat for each added repo)

#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import dotenv from "dotenv";
import { defaultKittuHome, setGlobalErrorReporter } from "kittu-core";
import { Application } from "./Application.js";
import { AuthCommand } from "./commands/AuthCommand.js";
import { CheckTokensCommand } from "./commands/CheckTokensCommand.js";
import { RefreshTokenCommand } from "./commands/RefreshTokenCommand.js";
import { SelfAddRepoCommand } from "./commands/SelfAddRepoCommand.js";
import { SelfAuthCommand } from "./commands/SelfAuthCommand.js";
import { StartCommand } from "./commands/StartCommand.js";
import { createErrorReporter } from "./services/createErrorReporter.js";

// Get the directory of the current module for reading package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json to get the actual version
// When compiled, this is in dist/src/, so we need to go up two levels
const packageJsonPath = resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Pre-load env vars from the resolved .env file before initialising Sentry, so
// that KITTU_SENTRY_DISABLED / KITTU_SENTRY_DSN take effect on the first run.
// We re-resolve the path inside Application using the same precedence (CLI
// flag wins); this preliminary load only honours KITTU_HOME and the default.
preloadEnvForBootstrap();

// Initialise the error reporter as early as possible so that exceptions
// thrown by subsequent imports/bootstrap are captured. Install it as the
// process-wide reporter so that every Logger.error(...) call across the
// codebase forwards to Sentry automatically.
const errorReporter = createErrorReporter({ release: packageJson.version });
setGlobalErrorReporter(errorReporter);

// Setup Commander program
const program = new Command();

program
	.name("kittu")
	.description("AI-powered Linear issue automation using Claude")
	.version(packageJson.version)
	.option(
		"--kittu-home <path>",
		"Specify custom Kittu config directory",
		defaultKittuHome(),
	)
	.option("--env-file <path>", "Path to environment variables file");

// Start command (default)
program
	.command("start", { isDefault: true })
	.description("Start the edge worker")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.kittuHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		await new StartCommand(app).execute([]);
	});

// Auth command
program
	.command("auth <auth-key>")
	.description("Authenticate with Kittu using auth key")
	.action(async (authKey: string) => {
		const opts = program.opts();
		const app = new Application(
			opts.kittuHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		await new AuthCommand(app).execute([authKey]);
	});

// Check tokens command
program
	.command("check-tokens")
	.description("Check the status of all Linear tokens")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.kittuHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		await new CheckTokensCommand(app).execute([]);
	});

// Refresh token command
program
	.command("refresh-token")
	.description("Refresh a specific Linear token")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.kittuHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		await new RefreshTokenCommand(app).execute([]);
	});

// Self-auth-linear command - Linear OAuth directly from CLI
program
	.command("self-auth-linear")
	.description("Authenticate with Linear OAuth directly")
	.option(
		"--tenant <id>",
		"Authorize this tenant's own Linear OAuth app (stop kittu-agent first: the callback uses its port)",
	)
	.option(
		"--expect-slug <slug>",
		"Refuse to save unless the authorized workspace has this urlKey",
	)
	.action(async (cmdOptions: { tenant?: string; expectSlug?: string }) => {
		const opts = program.opts();
		const app = new Application(
			opts.kittuHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		await new SelfAuthCommand(app).execute([], cmdOptions);
	});

// Self-add-repo command - Clone and add repository
program
	.command("self-add-repo [url] [workspace]")
	.description(
		'Clone a repo and add it to config. URL accepts any valid git clone address (e.g., "https://github.com/org/repo.git"). Workspace is the display name of the Linear workspace (e.g., "My Workspace"). If URL is omitted, prompts interactively.',
	)
	.option(
		"-l, --label <labels>",
		"Comma-separated routing labels (defaults to repo name)",
	)
	.option(
		"-b, --base-branch <branch>",
		"Base branch name (auto-detected from remote if not specified)",
	)
	.action(
		async (
			url: string | undefined,
			workspace: string | undefined,
			cmdOpts: { label?: string; baseBranch?: string },
		) => {
			const opts = program.opts();
			const app = new Application(
				opts.kittuHome,
				opts.envFile,
				packageJson.version,
			);
			const args = [url, workspace].filter(Boolean) as string[];
			if (cmdOpts.label) {
				args.push("-l", cmdOpts.label);
			}
			if (cmdOpts.baseBranch) {
				args.push("-b", cmdOpts.baseBranch);
			}
			await new SelfAddRepoCommand(app).execute(args);
		},
	);

// Parse and execute
(async () => {
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		errorReporter.captureException(error, { tags: { phase: "bootstrap" } });
		await errorReporter.flush(2000).catch(() => false);
		console.error("Fatal error:", error);
		process.exit(1);
	}
})();

/**
 * Best-effort env preload so the error reporter can read its config before the
 * full {@link Application} bootstrap. We honour `--env-file` only as a literal
 * argv lookup (Commander hasn't parsed yet) and otherwise fall back to the
 * default `<kittu-home>/.env` path.
 */
function preloadEnvForBootstrap(): void {
	const argv = process.argv.slice(2);
	const flagIdx = argv.indexOf("--env-file");
	const kittuHomeIdx = argv.indexOf("--kittu-home");

	const envFile = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
	const kittuHome =
		kittuHomeIdx >= 0 && argv[kittuHomeIdx + 1]
			? (argv[kittuHomeIdx + 1] as string)
			: defaultKittuHome();

	const path = envFile ?? join(kittuHome, ".env");
	if (existsSync(path)) {
		dotenv.config({ path, override: false });
	}
}

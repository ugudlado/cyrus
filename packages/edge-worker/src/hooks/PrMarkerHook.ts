import { execFileSync, spawnSync } from "node:child_process";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * The hidden HTML marker that identifies a PR/MR description as Cyrus-authored.
 * Its presence is what tells our GitHub/GitLab webhook handlers that a
 * "Changes requested" or comment event should be forwarded back to Cyrus.
 */
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

/**
 * Provider-specific knowledge about how to detect PR/MR mutating commands and
 * how to read/write the description on the underlying forge. Adding support
 * for a new forge means adding a new provider — no changes to the hook itself.
 */
export interface PrMarkerProvider {
	/** Provider name, used only for log messages. */
	readonly name: string;
	/** Returns true when `command` will create or update a PR/MR via this provider. */
	matches(command: string): boolean;
	/**
	 * Idempotently ensures the marker is present at the end of the live PR/MR
	 * description for the branch checked out at `cwd`. Implementations should
	 * be a no-op when no PR/MR exists yet, or when the marker is already there.
	 */
	ensureMarker(cwd: string, log: ILogger): void | Promise<void>;
}

/**
 * Append the marker to a body, preserving a single trailing newline.
 * Idempotent: returns the original body when the marker is already present.
 */
export function appendMarker(body: string | null | undefined): string {
	const current = body ?? "";
	if (current.includes(CYRUS_PR_MARKER)) {
		return current;
	}
	const trimmed = current.replace(/\s+$/, "");
	if (trimmed.length === 0) {
		return CYRUS_PR_MARKER;
	}
	return `${trimmed}\n\n${CYRUS_PR_MARKER}`;
}

/** What the GitHub provider needs to run gh safely (see {@link SessionGit.ghContextFor}). */
export interface PrMarkerGhContext {
	/** Absolute path of the real gh. */
	binary: string;
	/** Neutral cwd (never the workspace). */
	cwd: string;
	/** Complete child env: explicit GH_TOKEN, empty GH_CONFIG_DIR, fixed PATH. */
	env: Record<string, string>;
	/** OWNER/NAME from the trusted repository config. */
	slug: string;
	/** Branch the parent created for the session. */
	branch: string;
	cleanup(): void;
}

/** Resolves the gh context for a tool cwd, or null when gh must not run. */
export type PrMarkerGhResolver = (
	cwd: string,
) => Promise<PrMarkerGhContext | null>;

/**
 * GitHub provider: uses the `gh` CLI. Also covers `gt submit` (Graphite),
 * which submits via the GitHub API and ends up viewable through `gh pr view`.
 *
 * gh runs git itself and discovers the repository, branch and token from its
 * cwd, all session-writable. So it is run by absolute path from a neutral cwd
 * with `-R OWNER/NAME` and an explicit branch from the parent's records, an
 * explicit GH_TOKEN and an empty GH_CONFIG_DIR. Without a resolver (or when it
 * returns null) the provider does nothing.
 */
export class GitHubPrMarkerProvider implements PrMarkerProvider {
	readonly name = "github";

	constructor(private resolveGh?: PrMarkerGhResolver) {}

	matches(command: string): boolean {
		// Strip surrounding shell noise; we only care whether the command line
		// contains a PR-mutating gh/gt invocation.
		return (
			/\bgh\s+pr\s+(create|edit)\b/.test(command) ||
			/\bgt\s+submit\b/.test(command)
		);
	}

	async ensureMarker(cwd: string, log: ILogger): Promise<void> {
		const gh = await this.resolveGh?.(cwd);
		if (!gh) {
			return;
		}
		try {
			this.ensureWithGh(gh, log);
		} finally {
			gh.cleanup();
		}
	}

	private ensureWithGh(gh: PrMarkerGhContext, log: ILogger): void {
		let payload: { body?: string; number?: number };
		try {
			const json = execFileSync(
				gh.binary,
				["pr", "view", gh.branch, "-R", gh.slug, "--json", "body,number"],
				{
					cwd: gh.cwd,
					env: gh.env,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			payload = JSON.parse(json) as { body?: string; number?: number };
		} catch {
			// No PR for this branch yet, gh not authenticated, or not a GitHub
			// repo. Either way, nothing for us to ensure — bail silently.
			return;
		}

		if (typeof payload.number !== "number") {
			return;
		}
		const updated = appendMarker(payload.body);
		if (updated === (payload.body ?? "")) {
			return;
		}

		const result = spawnSync(
			gh.binary,
			["pr", "edit", String(payload.number), "-R", gh.slug, "--body-file", "-"],
			{
				cwd: gh.cwd,
				env: gh.env,
				input: updated,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] gh pr edit failed for #${payload.number}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitHub PR #${payload.number}`,
		);
	}
}

/**
 * GitLab provider — uses the `glab` CLI.
 */
export class GitLabMrMarkerProvider implements PrMarkerProvider {
	readonly name = "gitlab";

	matches(command: string): boolean {
		return /\bglab\s+mr\s+(create|update|edit)\b/.test(command);
	}

	/**
	 * Deliberately a no-op. `glab` discovers the repository, branch and token
	 * from its cwd (session-writable), like `gh` did before the parent-side git
	 * hardening, and has no pinned context yet. The GitLab MR marker stays
	 * disabled until it is converted the way {@link GitHubPrMarkerProvider} is
	 * (absolute binary, neutral cwd, explicit project and token).
	 */
	ensureMarker(_cwd: string, log: ILogger): void {
		log.debug("[PrMarkerHook] GitLab MR marker is disabled (not converted)");
	}
}

/**
 * Build the PostToolUse hook that ensures Cyrus's identifying marker is
 * present on every PR/MR Cyrus creates or updates.
 *
 * Wired alongside the screenshot/stop hooks in RunnerConfigBuilder. Designed
 * around the strategy pattern: `providers` is injectable so tests can stub
 * forge interactions and so new forges can be added without touching this
 * function.
 */
export function buildPrMarkerHook(
	log: ILogger,
	providers: PrMarkerProvider[] = [new GitHubPrMarkerProvider()],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input) => {
						const post = input as PostToolUseHookInput;
						const command =
							(post.tool_input as { command?: string } | undefined)?.command ??
							"";
						const provider = providers.find((p) => p.matches(command));
						if (!provider) {
							return {};
						}
						try {
							await provider.ensureMarker(post.cwd, log);
						} catch (err) {
							log.warn(
								`[PrMarkerHook] ${provider.name} provider threw: ${
									(err as Error).message
								}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ILogger, KittuAgentSession, RepositoryConfig } from "kittu-core";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_ENV_FORBIDDEN_IN_SESSION, GitEnv } from "../src/gitEnv.js";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";
import {
	makeSessionFixture,
	type SessionFixture,
} from "./helpers/sessionGitFixture.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

let fx: SessionFixture | undefined;
afterEach(() => fx?.cleanup());

describe("parent git env never reaches the session", () => {
	it("keeps GIT_* pins, hooks dir and credential helper out of the runner env and config", () => {
		fx = makeSessionFixture();
		const hooks = join(fx.root, "pinned-hooks");
		const gitEnv = new GitEnv({
			kittuHome: join(fx.root, "home"),
			hooksDir: hooks,
			credentialHelper: "/opt/pinned/credential-helper",
			ghBinary: "/opt/pinned/gh",
		});
		const builder = new RunnerConfigBuilder(
			{ buildChatAllowedTools: () => [] } as IChatToolResolver,
			{
				buildMcpConfig: () => ({}),
				buildMergedMcpConfigPath: () => undefined,
			} as IMcpConfigProvider,
			{
				determineRunnerSelection: () => ({ runnerType: "claude" as const }),
				getDefaultModelForRunner: () => "opus",
				getDefaultFallbackModelForRunner: () => "sonnet",
			} as IRunnerSelector,
			{ gitEnv },
		);
		const { config } = builder.buildIssueConfig({
			session: {
				issueId: "i",
				issue: { identifier: "ENG-1" },
				workspace: { path: fx.ws, isGitWorktree: true },
			} as unknown as KittuAgentSession,
			repository: {
				id: "repo-1",
				name: "r",
				repositoryPath: fx.repo,
			} as unknown as RepositoryConfig,
			sessionId: "s",
			systemPrompt: "t",
			allowedTools: [],
			allowedDirectories: [fx.ws],
			gitTargets: [fx.target],
			disallowedTools: [],
			kittuHome: join(fx.root, "home"),
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			githubToken: "ghs_token",
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/tmp/ca.pem",
		});

		const env = (config.additionalEnv ?? {}) as Record<string, string>;
		for (const key of GIT_ENV_FORBIDDEN_IN_SESSION) {
			expect(env, key).not.toHaveProperty(key);
		}
		expect(Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_"))).toEqual(
			[],
		);
		// None of the parent-only values appear anywhere in the runner config.
		const serialized = JSON.stringify(config.additionalEnv ?? {});
		for (const secret of [
			hooks,
			"/opt/pinned/credential-helper",
			"/opt/pinned/gh",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});
});

describe("hygiene: every parent git/gh process call is argv-form with an explicit env", () => {
	const files = [
		"GitService.ts",
		"RunnerConfigBuilder.ts",
		"hooks/IntentToAddHook.ts",
		"hooks/PrMarkerHook.ts",
		"gitEnv.ts",
	];
	const callRe = /\b(execSync|execFileSync|spawnSync|spawn)\(/g;

	/** Source text of the balanced call starting at `start` (index of the `(`). */
	function callText(src: string, start: number): string {
		let depth = 0;
		for (let i = start; i < src.length; i++) {
			if (src[i] === "(") depth++;
			if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1);
		}
		return src.slice(start);
	}

	// Allowed raw calls: repo hook scripts (explicit env), the pinned runner in
	// gitEnv.ts (env: inv.env) and gh by absolute path with the gh env. There
	// is no glab exemption: the GitLab MR marker is disabled.
	it("no execSync of a git/gh command string anywhere", () => {
		// gitEnv.ts holds the one sanctioned runner (GitEnv.run).
		for (const f of files.filter((x) => x !== "gitEnv.ts")) {
			const src = readFileSync(join(__dirname, "../src", f), "utf8");
			expect(src, f).not.toMatch(/execSync\(\s*[`"']\s*(git|gh)\b/);
			expect(src, f).not.toMatch(/execFileSync\(\s*["'](git|gh)["']/);
		}
	});

	it("every process call passes env: explicitly (no exemptions)", () => {
		const offenders: string[] = [];
		for (const f of files) {
			const src = readFileSync(join(__dirname, "../src", f), "utf8");
			for (const m of src.matchAll(callRe)) {
				const text = callText(src, (m.index ?? 0) + m[1]!.length);
				if (/import|^\(\s*$/.test(text.slice(0, 3))) continue;
				if (/\benv\b/.test(text)) continue;
				offenders.push(
					`${f}: ${m[1]}${text.slice(0, 60).replace(/\s+/g, " ")}`,
				);
			}
		}
		expect(offenders).toEqual([]);
	});
});

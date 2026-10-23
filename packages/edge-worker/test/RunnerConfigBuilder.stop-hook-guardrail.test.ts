import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StopHookInput } from "kittu-claude-runner";
import type { ILogger } from "kittu-core";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionGit } from "../src/gitEnv.js";
import {
	buildStopHook,
	inspectGitGuardrail,
} from "../src/RunnerConfigBuilder.js";
import {
	git,
	makeSessionFixture,
	type SessionFixture,
} from "./helpers/sessionGitFixture.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

let fixtures: SessionFixture[] = [];
function session(opts: { remote?: boolean; branch?: string } = {}) {
	const fx = makeSessionFixture(opts);
	fixtures.push(fx);
	return fx;
}
afterEach(() => {
	for (const fx of fixtures) fx.cleanup();
	fixtures = [];
});

function makeStopInput(overrides: Partial<StopHookInput> = {}): StopHookInput {
	return {
		hook_event_name: "Stop",
		session_id: "test-session",
		transcript_path: "/tmp/transcript",
		cwd: "/tmp",
		stop_hook_active: false,
		...overrides,
	} as StopHookInput;
}

function getStopHookCallback(sessionGit?: SessionGit) {
	const hooks = buildStopHook(silentLogger, sessionGit);
	const stop = hooks.Stop;
	if (!stop || stop.length === 0) {
		throw new Error("expected Stop hook entries");
	}
	const matcher = stop[0];
	expect(matcher.matcher).toBe(".*");
	const callback = matcher.hooks[0];
	if (!callback) {
		throw new Error("expected at least one Stop hook callback");
	}
	return callback;
}

describe("buildStopHook", () => {
	it("returns the Stop hook with a single `.*` matcher", () => {
		const hooks = buildStopHook(silentLogger);
		expect(Object.keys(hooks)).toEqual(["Stop"]);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop?.[0].matcher).toBe(".*");
		expect(hooks.Stop?.[0].hooks).toHaveLength(1);
	});

	it("allows the stop through when the working tree is clean", async () => {
		const fx = session({ remote: true });
		const callback = getStopHookCallback(fx.sessionGit);
		const result = await callback(
			makeStopInput({ cwd: fx.ws, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);
		expect(result).toEqual({});
	});

	it("blocks the first stop attempt when there are uncommitted tracked changes", async () => {
		const fx = session();
		writeFileSync(join(fx.ws, "README.md"), "modified\n");

		const callback = getStopHookCallback(fx.sessionGit);
		const result = (await callback(
			makeStopInput({ cwd: fx.ws, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		)) as { decision?: string; reason?: string };

		expect(result.decision).toBe("block");
		expect(result.reason).toContain("1 uncommitted file change");
		expect(result.reason).toContain("Create or update a pull request");
	});

	it("does not use the invalid `additionalContext` or `continue` fields when blocking", async () => {
		const fx = session();
		writeFileSync(join(fx.ws, "README.md"), "modified\n");

		const callback = getStopHookCallback(fx.sessionGit);
		const result = (await callback(
			makeStopInput({ cwd: fx.ws, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		)) as Record<string, unknown>;

		expect(result).not.toHaveProperty("additionalContext");
		expect(result).not.toHaveProperty("continue");
	});

	it("allows the stop through when `stop_hook_active` is true even with dirty tree", async () => {
		const fx = session();
		writeFileSync(join(fx.ws, "README.md"), "modified\n");

		const callback = getStopHookCallback(fx.sessionGit);
		const result = await callback(
			makeStopInput({ cwd: fx.ws, stop_hook_active: true }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({});
	});

	it("does not block when no trusted git target exists for cwd", async () => {
		const fx = session();
		writeFileSync(join(fx.ws, "README.md"), "modified\n");
		const callback = getStopHookCallback(); // no SessionGit
		const result = await callback(
			makeStopInput({ cwd: fx.ws, stop_hook_active: false }),
			"tool-use-id",
			{ signal: new AbortController().signal },
		);
		expect(result).toEqual({});
	});
});

describe("inspectGitGuardrail", () => {
	it("returns null when cwd is not a trusted git worktree", () => {
		const fx = session();
		expect(
			inspectGitGuardrail(fx.root, silentLogger, fx.sessionGit),
		).toBeNull();
	});

	it("returns null on a clean repo with no commits ahead of upstream", () => {
		const fx = session({ remote: true });
		expect(inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit)).toBeNull();
	});

	it("returns null when the only working-tree change is a pre-existing untracked file", () => {
		// Cooper @ QuitCarbon's case: a stray untracked file outside .gitignore
		// must not block the agent from stopping.
		const fx = session();
		writeFileSync(join(fx.ws, "scratch.txt"), "stray\n");
		expect(inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit)).toBeNull();
	});

	it("returns a guardrail message for uncommitted changes to tracked files", () => {
		const fx = session();
		writeFileSync(join(fx.ws, "README.md"), "modified\n");

		const message = inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit);
		expect(message).toContain("1 uncommitted file change");
		expect(message).toContain("Create or update a pull request");
	});

	it("flags intent-to-add files so forgotten new files still block", () => {
		// IntentToAddHook marks newly-Written files with `git add -N`. The
		// guardrail must continue to see those as uncommitted work even
		// though `--untracked-files=no` is set.
		const fx = session();
		writeFileSync(join(fx.ws, "new-feature.ts"), "export const x = 1;\n");
		git(fx.ws, "add", "--intent-to-add", "new-feature.ts");

		const message = inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit);
		expect(message).toContain("1 uncommitted file change");
	});

	it("counts commits ahead of upstream as unshipped work", () => {
		const fx = session({ remote: true });
		writeFileSync(join(fx.ws, "feature.txt"), "feature\n");
		git(fx.ws, "add", "feature.txt");
		git(fx.ws, "commit", "-m", "feature");

		const message = inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit);
		expect(message).toContain("1 commit");
		expect(message).toContain("not yet on the remote");
	});

	it("branch upstream set to origin/<branch>: counts unpushed before push, 0 after", () => {
		const fx = session({ remote: true, branch: "feat/x" });
		git(fx.repo, "remote", "set-head", "origin", "main");

		// What GitService does for a new branch (sandbox can't write config).
		git(fx.repo, "config", "branch.feat/x.remote", "origin");
		git(fx.repo, "config", "branch.feat/x.merge", "refs/heads/feat/x");
		writeFileSync(join(fx.ws, "feature.txt"), "feature\n");
		git(fx.ws, "add", "feature.txt");
		git(fx.ws, "commit", "-m", "feature");

		// origin/feat/x missing: @{u} fails, fallback to origin/HEAD counts it.
		const before = inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit);
		expect(before).toContain("1 commit");
		expect(before).toContain("not yet on the remote");

		// After a push (no -u) the remote-tracking ref exists at HEAD.
		git(fx.ws, "push", "origin", "feat/x");
		expect(inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit)).toBeNull();
	});
});

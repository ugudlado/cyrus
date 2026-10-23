import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { GitHubAppTokenProvider } from "cyrus-github-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import { GitEnv, SessionGit } from "../src/gitEnv.js";
import {
	applyIntentToAdd,
	DefaultIntentToAddGitClient,
} from "../src/hooks/IntentToAddHook.js";
import { GitHubPrMarkerProvider } from "../src/hooks/PrMarkerHook.js";
import { inspectGitGuardrail } from "../src/RunnerConfigBuilder.js";
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

/**
 * A COMPLETE evil git dir: a bare repo whose config and hooks would run code
 * (fsmonitor, hooks, ssh, credential helper, filters) and redirect the remote
 * (insteadOf). Every script appends to a marker file when it runs.
 */
function buildEvilGitDir(root: string): { dir: string; markers: string } {
	const dir = join(root, "evil.git");
	const markers = join(root, "markers");
	mkdirSync(markers);
	const script = (name: string, body = "") => {
		const p = join(root, name);
		writeFileSync(p, `#!/bin/sh\necho ran >> "${markers}/${name}"\n${body}\n`);
		chmodSync(p, 0o755);
		return p;
	};
	git(root, "init", "--bare", dir);
	const hooksDir = join(root, "evilhooks");
	mkdirSync(hooksDir);
	for (const h of [
		"pre-commit",
		"post-checkout",
		"reference-transaction",
		"post-merge",
		"post-index-change",
	]) {
		const p = join(hooksDir, h);
		writeFileSync(p, `#!/bin/sh\necho ran >> "${markers}/hook-${h}"\n`);
		chmodSync(p, 0o755);
		// also drop it into the evil dir's own hooks/
		writeFileSync(join(dir, "hooks", h), readFileSync(p));
		chmodSync(join(dir, "hooks", h), 0o755);
	}
	const set = (k: string, v: string) => git(dir, "config", k, v);
	set("core.bare", "false");
	set("core.fsmonitor", script("fsmonitor.sh", "printf '\\0'"));
	set("core.hooksPath", hooksDir);
	set("core.sshCommand", script("ssh.sh"));
	set("credential.helper", `!${script("credential.sh")}`);
	set("filter.x.smudge", script("smudge.sh", "cat"));
	set("url.https://evil.example/.insteadOf", "https://github.com/");
	return { dir, markers };
}

const markerNames = (markers: string) => readdirSync(markers).sort();

type Vector = "commondir" | "gitfile";

function forge(fx: SessionFixture, evil: string, vector: Vector) {
	if (vector === "commondir") {
		// The session can write worktrees/<id>/.
		writeFileSync(
			join(fx.repo, ".git", "worktrees", "ENG-1", "commondir"),
			`${evil}\n`,
		);
	} else {
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${evil}\n`);
	}
}

/** The converted parent calls, run against a (forged) session worktree. */
function runConvertedCalls(fx: SessionFixture): { guardrail: string | null } {
	writeFileSync(join(fx.ws, "README.md"), "modified\n");
	const guardrail = inspectGitGuardrail(fx.ws, silentLogger, fx.sessionGit);
	const newFile = join(fx.ws, "new.ts");
	writeFileSync(newFile, "x\n");
	applyIntentToAdd(
		new DefaultIntentToAddGitClient(fx.sessionGit),
		fx.ws,
		newFile,
		silentLogger,
	);
	return { guardrail };
}

describe.each([
	"commondir",
	"gitfile",
] as const)("evil git dir via %s forgery", (vector) => {
	let fx: SessionFixture;
	let evil: { dir: string; markers: string };
	beforeEach(() => {
		fx = makeSessionFixture({ remote: true });
		evil = buildEvilGitDir(fx.root);
		git(fx.repo, "remote", "set-url", "origin", fx.remote as string);
	});
	afterEach(() => fx.cleanup());

	it("NEGATIVE CONTROL: unpinned git discovered from the workspace runs the evil config", () => {
		forge(fx, evil.dir, vector);
		// What the parent did before: plain git with cwd in the workspace.
		for (const args of [
			["status", "--porcelain", "--untracked-files=no"],
			["add", "--intent-to-add", "--", "new.ts"],
		]) {
			writeFileSync(join(fx.ws, "new.ts"), "x\n");
			try {
				execFileSync("git", args, { cwd: fx.ws, stdio: "ignore" });
			} catch {
				// failing is fine; the marker is what matters
			}
		}
		expect(markerNames(evil.markers)).toContain("fsmonitor.sh");
	});

	it("pinned parent calls run nothing from the evil dir and still work", () => {
		forge(fx, evil.dir, vector);
		const { guardrail } = runConvertedCalls(fx);
		expect(markerNames(evil.markers)).toEqual([]);
		if (vector === "commondir") {
			// Pins ignore the forged commondir: the real repo answers.
			expect(guardrail).toContain("1 uncommitted file change");
			expect(
				git(fx.ws, "status", "--porcelain", "--untracked-files=no"),
			).toBeDefined();
		} else {
			// The gitfile points at evil.git; pinned GIT_DIR ignores it too.
			expect(guardrail).toContain("uncommitted file change");
		}
	});

	it("GitService calls run nothing from the evil dir and succeed", async () => {
		forge(fx, evil.dir, vector);
		const service = new GitService(
			{
				cyrusHome: join(fx.root, "home"),
				gitAllowFileProtocol: true,
				cloneMinFreeBytes: 0,
			},
			silentLogger,
		);
		expect(await service.branchExists("main", fx.repo)).toBe(true);
		const created = await service.createGitWorktree(
			{
				id: "i2",
				identifier: "ENG-2",
				title: "two",
				branchName: "eng-2",
			} as never,
			[
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: fx.repo,
					workspaceBaseDir: join(fx.root, "worktrees"),
					baseBranch: "main",
				} as never,
			],
		);
		expect(created.isGitWorktree).toBe(true);
		expect(existsSync(join(created.path, "README.md"))).toBe(true);
		await service.deleteWorkspace("ENG-2", {
			repositories: [
				{ id: "repo-1", name: "repo", repositoryPath: fx.repo } as never,
			],
		});
		expect(markerNames(evil.markers)).toEqual([]);
	});
});

describe("PR marker with a stub gh", () => {
	let fx: SessionFixture;
	let rec: string;
	let stub: string;
	beforeEach(() => {
		fx = makeSessionFixture();
		git(
			fx.repo,
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widgets.git",
		);
		rec = join(fx.root, "gh-record");
		mkdirSync(rec);
		stub = join(fx.root, "gh-stub");
		writeFileSync(
			stub,
			`#!/bin/sh
n=$(ls "${rec}" | wc -l | tr -d ' ')
{ echo "cwd=$(pwd)"; echo "token=$GH_TOKEN"; echo "cfg=$GH_CONFIG_DIR"; echo "cfgcount=$(ls "$GH_CONFIG_DIR" | wc -l | tr -d ' ')"; echo "path=$PATH"; echo "args=$*"; } > "${rec}/call-$n"
if [ "$2" = view ]; then echo '{"body":"desc","number":7}'; else cat > "${rec}/stdin-$n"; fi
`,
		);
		chmodSync(stub, 0o755);
	});
	afterEach(() => fx.cleanup());

	const records = () =>
		readdirSync(rec)
			.filter((f) => f.startsWith("call-"))
			.sort()
			.map((f) => readFileSync(join(rec, f), "utf8"));

	const ghFor = (target = fx.target) => {
		const gitEnv = new GitEnv({
			cyrusHome: join(fx.root, "home"),
			ghBinary: stub,
		});
		return new SessionGit(gitEnv, [target]);
	};
	const run = (
		sg: SessionGit,
		tokens: Parameters<SessionGit["ghContextFor"]>[1],
		log: ILogger = silentLogger,
	) =>
		new GitHubPrMarkerProvider((cwd) =>
			sg.ghContextFor(cwd, tokens),
		).ensureMarker(fx.ws, log);

	it("runs the absolute gh from a neutral cwd with -R OWNER/NAME, the parent's branch and token", async () => {
		// Canary tokens planted where the old shim / a naive lookup would look.
		writeFileSync(join(fx.ws, "cyrus-gh-token"), "canary-from-workspace");
		await run(ghFor({ ...fx.target, storeToken: "parent-token" }), {});

		const calls = records();
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c).toContain(`cwd=${realpathSync.native(join(fx.root, "home"))}`);
			expect(c).toContain("token=parent-token");
			expect(c).not.toContain("canary-from-workspace");
			expect(c).toContain("cfgcount=0");
			expect(c).not.toMatch(/path=.*\/usr\/local\/bin/);
			expect(c).toContain("-R acme/widgets");
		}
		expect(calls[0]).toContain(
			"args=pr view main -R acme/widgets --json body,number",
		);
		expect(calls[1]).toContain("args=pr edit 7 -R acme/widgets --body-file -");
		expect(readFileSync(join(rec, "stdin-1"), "utf8")).toContain(
			"generated-by-cyrus",
		);
	});

	it("OWNER/NAME comes from the parent's repo config, not a workspace-side override", async () => {
		writeFileSync(
			join(fx.repo, ".git", "worktrees", "ENG-1", "config.worktree"),
			'[remote "origin"]\n\turl = https://github.com/evil/steal.git\n',
		);
		await run(ghFor({ ...fx.target, storeToken: "t" }), {});
		expect(records().length).toBeGreaterThan(0);
		expect(records().every((c) => c.includes("-R acme/widgets"))).toBe(true);
	});

	describe("scoped App token tier (mocked GitHub API)", () => {
		let pem: string;
		let fetchSpy: ReturnType<typeof vi.spyOn>;
		const target = () => ({
			...fx.target,
			githubUrl: "https://github.com/acme/widgets",
		});
		const provider = () =>
			new GitHubAppTokenProvider({
				appId: "1",
				installationId: "2",
				privateKeyPath: pem,
			});
		const reply = (token: string) =>
			new Response(
				JSON.stringify({
					token,
					expires_at: new Date(Date.now() + 3600_000).toISOString(),
				}),
				{ status: 201 },
			);
		beforeEach(() => {
			pem = join(fx.root, "app.pem");
			writeFileSync(
				pem,
				generateKeyPairSync("rsa", { modulusLength: 2048 })
					.privateKey.export({ type: "pkcs8", format: "pem" })
					.toString(),
			);
		});
		afterEach(() => fetchSpy?.mockRestore());

		it("mints a token scoped to the repo name from config and passes it as GH_TOKEN", async () => {
			fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => reply("ghs_scoped_minted"));
			const app = provider();
			await run(ghFor(target()), { appTokens: app, envToken: "env-pat" });

			expect(fetchSpy).toHaveBeenCalledOnce();
			const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
			expect(JSON.parse(init.body as string)).toEqual({
				repositories: ["widgets"],
				permissions: { pull_requests: "write" },
			});
			const calls = records();
			expect(calls).toHaveLength(2);
			expect(calls.every((c) => c.includes("token=ghs_scoped_minted"))).toBe(
				true,
			);
			// The full-installation cache was not touched: getToken() mints anew.
			fetchSpy.mockImplementation(async () => reply("ghs_full"));
			expect(await app.getToken()).toBe("ghs_full");
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});

		it("the token-store entry wins; the env PAT is used only when no App is configured", async () => {
			fetchSpy = vi.spyOn(globalThis, "fetch");
			await run(ghFor({ ...target(), storeToken: "store" }), {
				appTokens: provider(),
				envToken: "env-pat",
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(records().every((c) => c.includes("token=store"))).toBe(true);
		});

		it("falls back to the env PAT when no App provider is configured", async () => {
			await run(ghFor(target()), { envToken: "env-pat" });
			expect(records().every((c) => c.includes("token=env-pat"))).toBe(true);
		});

		it("a mint failure (422) runs gh zero times and logs only the repo name and status", async () => {
			fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response("{}", { status: 422 }));
			const lines: string[] = [];
			const log = {
				...silentLogger,
				debug: (...a: unknown[]) => lines.push(a.join(" ")),
				info: (...a: unknown[]) => lines.push(a.join(" ")),
				warn: (...a: unknown[]) => lines.push(a.join(" ")),
				error: (...a: unknown[]) => lines.push(a.join(" ")),
			} as unknown as ILogger;
			const sg = new SessionGit(
				new GitEnv({ cyrusHome: join(fx.root, "home"), ghBinary: stub }),
				[target()],
				log,
			);
			await run(sg, { appTokens: provider(), envToken: "env-pat" }, log);

			expect(records()).toHaveLength(0);
			expect(
				lines.some((l) => l.includes("widgets") && l.includes("422")),
			).toBe(true);
			expect(lines.join("\n")).not.toContain("env-pat");
		});

		it("the minted token never appears in logs", async () => {
			fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => reply("ghs_never_log_me"));
			const lines: string[] = [];
			const push = (...a: unknown[]) => lines.push(a.join(" "));
			const log = {
				debug: push,
				info: push,
				warn: push,
				error: push,
			} as unknown as ILogger;
			const sg = new SessionGit(
				new GitEnv({ cyrusHome: join(fx.root, "home"), ghBinary: stub }),
				[target()],
				log,
			);
			await run(sg, { appTokens: provider() }, log);
			expect(records().length).toBeGreaterThan(0);
			expect(lines.join("\n")).not.toContain("ghs_never_log_me");
		});

		it("App configured but no githubUrl: no mint, no gh call, the PAT is not used", async () => {
			fetchSpy = vi.spyOn(globalThis, "fetch");
			await run(ghFor(), { appTokens: provider(), envToken: "env-pat" });
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(records()).toHaveLength(0);
		});
	});

	it("is a no-op without ghBinary or a resolver", async () => {
		await new GitHubPrMarkerProvider().ensureMarker(fx.ws, silentLogger);
		await new GitHubPrMarkerProvider((cwd) =>
			fx.sessionGit.ghContextFor(cwd, { envToken: "t" }),
		).ensureMarker(fx.ws, silentLogger);
		expect(records()).toHaveLength(0);
	});
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleKittuConfig } from "../../src/handlers/kittuConfig.js";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("handleKittuConfig", () => {
	const kittuHome = "/test/kittu-home";

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.KITTU_WORKTREES_DIR;
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockReturnValue("");
	});

	afterEach(() => {
		delete process.env.KITTU_WORKTREES_DIR;
	});

	it("defaults repository workspaceBaseDir to kittuHome/worktrees", async () => {
		const result = await handleKittuConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			kittuHome,
		);

		expect(result.success).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith(kittuHome, { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/kittu-home/config.json",
			expect.stringContaining(
				'"workspaceBaseDir": "/test/kittu-home/worktrees"',
			),
			"utf-8",
		);
	});

	it("uses KITTU_WORKTREES_DIR when set", async () => {
		process.env.KITTU_WORKTREES_DIR = "/tmp/custom-worktrees";

		const result = await handleKittuConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			kittuHome,
		);

		expect(result.success).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/test/kittu-home/config.json",
			expect.stringContaining('"workspaceBaseDir": "/tmp/custom-worktrees"'),
			"utf-8",
		);
	});
});

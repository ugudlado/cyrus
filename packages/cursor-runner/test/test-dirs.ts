import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const _base = mkdtempSync(join(tmpdir(), "kittu-cursor-runner-"));

/**
 * Unique per-run temp paths for tests. Uses mkdtempSync so simultaneous
 * test runs from different worktrees or processes use separate directories.
 * Also avoids EACCES on shared /tmp across multiple user accounts.
 */
export const TEST_KITTU_HOME = join(_base, "kittu-home");
export const TEST_WORKING_DIR = join(_base, "workspace");

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import { cleanupTempDir, commitFile, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { MergeEntry } from "../types.ts";
import { createMergeResolver } from "./resolver.ts";

/**
 * Helper to create a mock Bun.spawn return value for claude CLI mocking.
 *
 * The resolver reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

function makeTestEntry(overrides?: Partial<MergeEntry>): MergeEntry {
	return {
		branchName: overrides?.branchName ?? "feature-branch",
		beadId: overrides?.beadId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

describe("createMergeResolver", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await createTempGitRepo();
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	describe("Tier 1: Clean merge", () => {
		test("returns success with tier clean-merge when git merge succeeds", async () => {
			// Commit a file on main
			await commitFile(repoDir, "src/main-file.ts", "main content\n");

			// Create feature branch and commit a different file
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/feature-file.ts", "feature content\n");

			// Switch back to main
			await runGitInDir(repoDir, ["checkout", "main"]);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/feature-file.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(true);
			expect(result.tier).toBe("clean-merge");
			expect(result.entry.status).toBe("merged");
			expect(result.entry.resolvedTier).toBe("clean-merge");
			expect(result.conflictFiles).toEqual([]);
			expect(result.errorMessage).toBeNull();
		});

		test("feature file exists on main after clean merge", async () => {
			await commitFile(repoDir, "src/main-file.ts", "main content\n");

			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/feature-file.ts", "feature content\n");
			await runGitInDir(repoDir, ["checkout", "main"]);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/feature-file.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(entry, "main", repoDir);

			// After merge, the feature file should exist on main
			const file = Bun.file(join(repoDir, "src/feature-file.ts"));
			const content = await file.text();
			expect(content).toBe("feature content\n");
		});

		test("throws MergeError if checkout fails", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			// Try to checkout a branch that doesn't exist
			await expect(resolver.resolve(entry, "nonexistent-branch", repoDir)).rejects.toThrow(
				MergeError,
			);
		});

		test("MergeError from checkout failure includes branch name", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			try {
				await resolver.resolve(entry, "develop", repoDir);
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("develop");
			}
		});
	});

	describe("Tier 1 fail -> Tier 2: Auto-resolve", () => {
		/**
		 * Set up a real content conflict: create a file, branch, modify on both
		 * branches. Both sides must diverge from the common ancestor to produce
		 * conflict markers.
		 */
		async function setupContentConflict(dir: string): Promise<void> {
			// Create original file on main (the common ancestor version)
			await commitFile(dir, "src/test.ts", "original content\n");

			// Create feature branch and modify the file
			await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
			await commitFile(dir, "src/test.ts", "feature content\n");

			// Switch back to main and make a different modification
			await runGitInDir(dir, ["checkout", "main"]);
			await commitFile(dir, "src/test.ts", "main modified content\n");
		}

		test("auto-resolves conflicts by keeping incoming changes", async () => {
			await setupContentConflict(repoDir);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(true);
			expect(result.tier).toBe("auto-resolve");
			expect(result.entry.status).toBe("merged");
			expect(result.entry.resolvedTier).toBe("auto-resolve");
		});

		test("resolved file contains incoming (branch) content", async () => {
			await setupContentConflict(repoDir);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(entry, "main", repoDir);

			// The resolved file should contain the incoming (feature branch) content
			const file = Bun.file(join(repoDir, "src/test.ts"));
			const content = await file.text();
			expect(content).toBe("feature content\n");
		});
	});

	describe("Tier 3: AI-resolve", () => {
		/**
		 * Create a delete/modify conflict: file is deleted on main but modified on
		 * the feature branch. This produces a conflict with NO conflict markers in
		 * the working copy, causing Tier 2 auto-resolve to fail (resolveConflictsKeepIncoming
		 * returns null). This naturally escalates to Tier 3 or 4.
		 */
		async function setupDeleteModifyConflict(dir: string): Promise<void> {
			// Create file on main
			await commitFile(dir, "src/test.ts", "original content\n");

			// Create feature branch and modify the file
			await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
			await commitFile(dir, "src/test.ts", "modified by agent\n");

			// Switch back to main and delete the file
			await runGitInDir(dir, ["checkout", "main"]);
			await runGitInDir(dir, ["rm", "src/test.ts"]);
			await runGitInDir(dir, ["commit", "-m", "delete src/test.ts"]);
		}

		test("is skipped when aiResolveEnabled is false", async () => {
			await setupDeleteModifyConflict(repoDir);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		test("invokes claude when aiResolveEnabled is true and tier 2 fails", async () => {
			await setupDeleteModifyConflict(repoDir);

			// Selective spy: mock only claude, let git commands through.
			// We need to save a reference to the real Bun.spawn before spying.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("resolved content from AI\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: true,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("ai-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("ai-resolve");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("Tier 4: Re-imagine", () => {
		/**
		 * Set up a scenario where Tier 2 auto-resolve fails but Tier 4 reimagine can
		 * succeed. We create a delete/modify conflict on one file (causes Tier 2 to fail)
		 * and set entry.filesModified to a different file that exists on both branches
		 * (so git show works for both in reimagine).
		 */
		async function setupReimagineScenario(dir: string): Promise<void> {
			// Create two files on main
			await commitFile(dir, "src/conflict-file.ts", "original content\n");
			await commitFile(dir, "src/reimagine-target.ts", "main version of target\n");

			// Create feature branch: modify both files
			await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
			await commitFile(dir, "src/conflict-file.ts", "modified by agent\n");
			await commitFile(dir, "src/reimagine-target.ts", "feature version of target\n");

			// Switch back to main: delete the conflict file (causes delete/modify conflict)
			await runGitInDir(dir, ["checkout", "main"]);
			await runGitInDir(dir, ["rm", "src/conflict-file.ts"]);
			await runGitInDir(dir, ["commit", "-m", "delete conflict file"]);
		}

		test("is skipped when reimagineEnabled is false", async () => {
			await setupReimagineScenario(repoDir);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/reimagine-target.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		test("aborts merge and reimplements when reimagineEnabled is true", async () => {
			await setupReimagineScenario(repoDir);

			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("reimagined content\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/reimagine-target.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: true,
				});

				const result = await resolver.resolve(entry, "main", repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("reimagine");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("reimagine");

				// Verify the reimagined content was written
				const file = Bun.file(join(repoDir, "src/reimagine-target.ts"));
				const content = await file.text();
				expect(content).toBe("reimagined content\n");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("All tiers fail", () => {
		test("returns failed status when all tiers are disabled or fail", async () => {
			// Create a delete/modify conflict that auto-resolve cannot handle
			await commitFile(repoDir, "src/test.ts", "original content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "modified by agent\n");
			await runGitInDir(repoDir, ["checkout", "main"]);
			await runGitInDir(repoDir, ["rm", "src/test.ts"]);
			await runGitInDir(repoDir, ["commit", "-m", "delete src/test.ts"]);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
			expect(result.entry.resolvedTier).toBeNull();
			expect(result.errorMessage).not.toBeNull();
			expect(result.errorMessage).toContain("failed");
		});

		test("repo is clean after total failure (merge aborted)", async () => {
			await commitFile(repoDir, "src/test.ts", "original content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "modified by agent\n");
			await runGitInDir(repoDir, ["checkout", "main"]);
			await runGitInDir(repoDir, ["rm", "src/test.ts"]);
			await runGitInDir(repoDir, ["commit", "-m", "delete src/test.ts"]);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(entry, "main", repoDir);

			// Verify the repo is in a clean state (merge was aborted)
			const status = await runGitInDir(repoDir, ["status", "--porcelain"]);
			expect(status.trim()).toBe("");
		});
	});

	describe("result shape", () => {
		test("successful result has correct MergeResult shape", async () => {
			await commitFile(repoDir, "src/main-file.ts", "main content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/feature-file.ts", "feature content\n");
			await runGitInDir(repoDir, ["checkout", "main"]);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(
				makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				}),
				"main",
				repoDir,
			);

			expect(result).toHaveProperty("entry");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("tier");
			expect(result).toHaveProperty("conflictFiles");
			expect(result).toHaveProperty("errorMessage");
		});

		test("failed result preserves original entry fields", async () => {
			// Create a conflict that cannot be auto-resolved
			await commitFile(repoDir, "src/test.ts", "original content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "overstory/my-agent/bead-xyz"]);
			await commitFile(repoDir, "src/test.ts", "modified by agent\n");
			await runGitInDir(repoDir, ["checkout", "main"]);
			await runGitInDir(repoDir, ["rm", "src/test.ts"]);
			await runGitInDir(repoDir, ["commit", "-m", "delete src/test.ts"]);

			const entry = makeTestEntry({
				branchName: "overstory/my-agent/bead-xyz",
				beadId: "bead-xyz",
				agentName: "my-agent",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", repoDir);

			expect(result.entry.branchName).toBe("overstory/my-agent/bead-xyz");
			expect(result.entry.beadId).toBe("bead-xyz");
			expect(result.entry.agentName).toBe("my-agent");
		});
	});
});

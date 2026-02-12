import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MergeError } from "../errors.ts";
import type { MergeEntry } from "../types.ts";
import { createMergeResolver } from "./resolver.ts";

/**
 * Helper to create a mock Bun.spawn return value.
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
		branchName: overrides?.branchName ?? "overstory/test-agent/bead-123",
		beadId: overrides?.beadId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

describe("createMergeResolver", () => {
	let spawnSpy: ReturnType<typeof spyOn>;
	let fileSpy: ReturnType<typeof spyOn>;
	let writeSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
		fileSpy = spyOn(Bun, "file");
		writeSpy = spyOn(Bun, "write");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
		fileSpy.mockRestore();
		writeSpy.mockRestore();
	});

	/** Extract all command arrays from spawn spy calls. */
	function getSpawnCommands(): string[][] {
		return spawnSpy.mock.calls.map((call: unknown[]) => call[0] as string[]);
	}

	describe("Tier 1: Clean merge", () => {
		test("returns success with tier clean-merge when git merge succeeds", async () => {
			const entry = makeTestEntry();
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) {
					// git checkout main
					return mockSpawnResult("", "", 0);
				}
				// git merge --no-edit <branch>
				return mockSpawnResult("", "", 0);
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(true);
			expect(result.tier).toBe("clean-merge");
			expect(result.entry.status).toBe("merged");
			expect(result.entry.resolvedTier).toBe("clean-merge");
			expect(result.conflictFiles).toEqual([]);
			expect(result.errorMessage).toBeNull();
		});

		test("checks out canonical branch first", async () => {
			let _callIndex = 0;
			spawnSpy.mockImplementation(() => {
				_callIndex++;
				// All succeed
				return mockSpawnResult("", "", 0);
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(makeTestEntry(), "main", "/repo");

			// First call should be git checkout main
			const firstCall = spawnSpy.mock.calls[0] as unknown[];
			const cmd = firstCall[0] as string[];
			expect(cmd).toEqual(["git", "checkout", "main"]);

			const opts = firstCall[1] as { cwd: string };
			expect(opts.cwd).toBe("/repo");
		});

		test("throws MergeError if checkout fails", async () => {
			spawnSpy.mockImplementation(() =>
				mockSpawnResult("", "error: pathspec 'main' did not match", 1),
			);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await expect(resolver.resolve(makeTestEntry(), "main", "/repo")).rejects.toThrow(MergeError);
		});

		test("MergeError from checkout failure includes branch name", async () => {
			spawnSpy.mockImplementation(() =>
				mockSpawnResult("", "error: pathspec 'develop' did not match", 1),
			);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			try {
				await resolver.resolve(makeTestEntry(), "develop", "/repo");
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("develop");
			}
		});
	});

	describe("Tier 1 fail -> Tier 2: Auto-resolve", () => {
		test("auto-resolves conflicts by keeping incoming changes", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation((...args: unknown[]) => {
				callIndex++;
				const _cmd = (args[0] as string[]).join(" ");

				if (callIndex === 1) {
					// git checkout main
					return mockSpawnResult("", "", 0);
				}
				if (callIndex === 2) {
					// git merge --no-edit <branch> — fails with conflict
					return mockSpawnResult("", "CONFLICT (content): Merge conflict", 1);
				}
				if (callIndex === 3) {
					// git diff --name-only --diff-filter=U
					return mockSpawnResult("src/test.ts\n", "", 0);
				}
				if (callIndex === 4) {
					// git add src/test.ts
					return mockSpawnResult("", "", 0);
				}
				if (callIndex === 5) {
					// git commit --no-edit
					return mockSpawnResult("", "", 0);
				}
				return mockSpawnResult("", "", 0);
			});

			// Mock Bun.file for reading conflict content
			fileSpy.mockImplementation(() => ({
				text: () =>
					Promise.resolve("<<<<<<< HEAD\nold content\n=======\nnew content\n>>>>>>> branch\n"),
				exists: () => Promise.resolve(true),
			}));

			// Mock Bun.write for writing resolved content
			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(true);
			expect(result.tier).toBe("auto-resolve");
			expect(result.entry.status).toBe("merged");
			expect(result.entry.resolvedTier).toBe("auto-resolve");
		});

		test("Bun.write is called with resolved content (incoming kept)", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				if (callIndex === 4) return mockSpawnResult("", "", 0); // git add
				if (callIndex === 5) return mockSpawnResult("", "", 0); // git commit
				return mockSpawnResult("", "", 0);
			});

			fileSpy.mockImplementation(() => ({
				text: () =>
					Promise.resolve("<<<<<<< HEAD\nold content\n=======\nnew content\n>>>>>>> branch\n"),
				exists: () => Promise.resolve(true),
			}));

			let writtenContent = "";
			writeSpy.mockImplementation((_path: unknown, content: unknown) => {
				writtenContent = content as string;
				return Promise.resolve(0);
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(entry, "main", "/repo");

			expect(writtenContent).toBe("new content\n");
		});
	});

	describe("Tier 3: AI-resolve", () => {
		test("is skipped when aiResolveEnabled is false", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				// Auto-resolve fails (no conflict markers found => null => remainingConflicts)
				if (callIndex === 4) return mockSpawnResult("", "", 0); // merge --abort (final cleanup)
				return mockSpawnResult("", "", 0);
			});

			// Return content without conflict markers so auto-resolve fails
			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("some content without conflict markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(false);
			// Should NOT have called claude --print
			const allCmds = getSpawnCommands();
			const claudeCalls = allCmds.filter((cmd: string[]) => cmd[0] === "claude");
			expect(claudeCalls).toHaveLength(0);
		});

		test("invokes claude --print when aiResolveEnabled is true and tier 2 fails", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });

			spawnSpy.mockImplementation((...args: unknown[]) => {
				const cmd = args[0] as string[];

				// git checkout main
				if (cmd[0] === "git" && cmd[1] === "checkout") {
					return mockSpawnResult("", "", 0);
				}
				// git merge --no-edit — fails with conflict
				if (cmd[0] === "git" && cmd[1] === "merge" && cmd[2] === "--no-edit") {
					return mockSpawnResult("", "CONFLICT", 1);
				}
				// git diff --name-only --diff-filter=U
				if (cmd[0] === "git" && cmd[1] === "diff") {
					return mockSpawnResult("src/test.ts\n", "", 0);
				}
				// claude --print (Tier 3)
				if (cmd[0] === "claude") {
					return mockSpawnResult("resolved content from AI", "", 0);
				}
				// git add
				if (cmd[0] === "git" && cmd[1] === "add") {
					return mockSpawnResult("", "", 0);
				}
				// git commit
				if (cmd[0] === "git" && cmd[1] === "commit") {
					return mockSpawnResult("", "", 0);
				}
				// merge --abort (cleanup)
				if (cmd[0] === "git" && cmd[1] === "merge" && cmd[2] === "--abort") {
					return mockSpawnResult("", "", 0);
				}
				return mockSpawnResult("", "", 0);
			});

			// Return content WITHOUT conflict markers so Tier 2 auto-resolve fails
			// (resolveConflictsKeepIncoming returns null => file goes to remainingConflicts)
			// Tier 3 then reads the same content and sends it to Claude
			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("content that has no conflict markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: true,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			// Verify claude was called
			const allCmds = getSpawnCommands();
			const claudeCalls = allCmds.filter((cmd: string[]) => cmd[0] === "claude");
			expect(claudeCalls.length).toBeGreaterThanOrEqual(1);
			expect(result.success).toBe(true);
			expect(result.tier).toBe("ai-resolve");
		});
	});

	describe("Tier 4: Re-imagine", () => {
		test("is skipped when reimagineEnabled is false", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				// All remaining calls fail or are cleanup
				return mockSpawnResult("", "", 1);
			});

			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("no markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(false);

			// Should NOT have called git merge --abort followed by git show (reimagine pattern)
			const allCmds = getSpawnCommands();
			const showCalls = allCmds.filter((cmd: string[]) => cmd[0] === "git" && cmd[1] === "show");
			expect(showCalls).toHaveLength(0);
		});

		test("aborts merge and reimplements when reimagineEnabled is true", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation((...args: unknown[]) => {
				callIndex++;
				const cmd = args[0] as string[];

				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff --name-only

				// Tier 2: auto-resolve — file has no markers, fails
				// (fileSpy returns no markers initially, then returns versions for reimagine)

				// Tier 4: reimagine
				if (cmd[0] === "git" && cmd[1] === "merge" && cmd[2] === "--abort") {
					return mockSpawnResult("", "", 0);
				}
				if (
					cmd[0] === "git" &&
					cmd[1] === "show" &&
					typeof cmd[2] === "string" &&
					cmd[2].startsWith("main:")
				) {
					return mockSpawnResult("canonical content", "", 0);
				}
				if (
					cmd[0] === "git" &&
					cmd[1] === "show" &&
					typeof cmd[2] === "string" &&
					cmd[2].startsWith("overstory/")
				) {
					return mockSpawnResult("branch content", "", 0);
				}
				if (cmd[0] === "claude") {
					return mockSpawnResult("reimagined content", "", 0);
				}
				if (cmd[0] === "git" && cmd[1] === "add") {
					return mockSpawnResult("", "", 0);
				}
				if (cmd[0] === "git" && cmd[1] === "commit") {
					return mockSpawnResult("", "", 0);
				}

				return mockSpawnResult("", "", 1);
			});

			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("no conflict markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: true,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(true);
			expect(result.tier).toBe("reimagine");
			expect(result.entry.status).toBe("merged");
			expect(result.entry.resolvedTier).toBe("reimagine");

			// Verify merge --abort was called
			const allCmds = getSpawnCommands();
			const abortCalls = allCmds.filter(
				(cmd: string[]) => cmd[0] === "git" && cmd[1] === "merge" && cmd[2] === "--abort",
			);
			expect(abortCalls.length).toBeGreaterThanOrEqual(1);

			// Verify git show was called for both canonical and branch versions
			const showCalls = allCmds.filter((cmd: string[]) => cmd[0] === "git" && cmd[1] === "show");
			expect(showCalls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("All tiers fail", () => {
		test("returns failed status when all tiers are disabled or fail", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				// Everything else fails or is cleanup
				return mockSpawnResult("", "", 1);
			});

			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("no conflict markers here"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
			expect(result.entry.resolvedTier).toBeNull();
			expect(result.errorMessage).not.toBeNull();
			expect(result.errorMessage).toContain("failed");
		});

		test("calls merge --abort on total failure", async () => {
			const entry = makeTestEntry({ filesModified: ["src/test.ts"] });
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				// Auto-resolve commit fails, everything else fails
				return mockSpawnResult("", "", 0);
			});

			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("no conflict markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await resolver.resolve(entry, "main", "/repo");

			// Verify merge --abort was called in the final cleanup
			const allCmds = getSpawnCommands();
			const abortCalls = allCmds.filter(
				(cmd: string[]) => cmd[0] === "git" && cmd[1] === "merge" && cmd[2] === "--abort",
			);
			expect(abortCalls.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("result shape", () => {
		test("successful result has correct MergeResult shape", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(makeTestEntry(), "main", "/repo");

			expect(result).toHaveProperty("entry");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("tier");
			expect(result).toHaveProperty("conflictFiles");
			expect(result).toHaveProperty("errorMessage");
		});

		test("failed result preserves original entry fields", async () => {
			const entry = makeTestEntry({
				branchName: "overstory/my-agent/bead-xyz",
				beadId: "bead-xyz",
				agentName: "my-agent",
			});
			let callIndex = 0;

			spawnSpy.mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) return mockSpawnResult("", "", 0); // checkout
				if (callIndex === 2) return mockSpawnResult("", "CONFLICT", 1); // merge fails
				if (callIndex === 3) return mockSpawnResult("src/test.ts\n", "", 0); // diff
				return mockSpawnResult("", "", 1);
			});

			fileSpy.mockImplementation(() => ({
				text: () => Promise.resolve("no markers"),
				exists: () => Promise.resolve(true),
			}));

			writeSpy.mockImplementation(() => Promise.resolve(0));

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, "main", "/repo");

			expect(result.entry.branchName).toBe("overstory/my-agent/bead-xyz");
			expect(result.entry.beadId).toBe("bead-xyz");
			expect(result.entry.agentName).toBe("my-agent");
		});
	});
});

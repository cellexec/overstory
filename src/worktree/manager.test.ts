import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { WorktreeError } from "../errors.ts";
import { createWorktree, listWorktrees, removeWorktree } from "./manager.ts";

/**
 * Helper to create a mock Bun.spawn return value.
 *
 * The actual code reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 * `new Response("text").body!` creates the right type.
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

describe("createWorktree", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("builds correct branch name and returns path and branch", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const result = await createWorktree({
			repoRoot: "/repo",
			baseDir: "/repo/.overstory/worktrees",
			agentName: "auth-login",
			baseBranch: "main",
			beadId: "bead-abc123",
		});

		expect(result.path).toBe("/repo/.overstory/worktrees/auth-login");
		expect(result.branch).toBe("overstory/auth-login/bead-abc123");
	});

	test("passes correct args to git worktree add", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await createWorktree({
			repoRoot: "/repo",
			baseDir: "/repo/.overstory/worktrees",
			agentName: "auth-login",
			baseBranch: "main",
			beadId: "bead-abc123",
		});

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"git",
			"worktree",
			"add",
			"-b",
			"overstory/auth-login/bead-abc123",
			"/repo/.overstory/worktrees/auth-login",
			"main",
		]);

		const opts = callArgs[1] as { cwd: string; stdout: string; stderr: string };
		expect(opts.cwd).toBe("/repo");
		expect(opts.stdout).toBe("pipe");
		expect(opts.stderr).toBe("pipe");
	});

	test("throws WorktreeError on git failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "fatal: branch already exists", 128));

		await expect(
			createWorktree({
				repoRoot: "/repo",
				baseDir: "/repo/.overstory/worktrees",
				agentName: "auth-login",
				baseBranch: "main",
				beadId: "bead-abc123",
			}),
		).rejects.toThrow(WorktreeError);
	});

	test("WorktreeError includes git error message", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "fatal: branch already exists", 128));

		try {
			await createWorktree({
				repoRoot: "/repo",
				baseDir: "/repo/.overstory/worktrees",
				agentName: "auth-login",
				baseBranch: "main",
				beadId: "bead-abc123",
			});
			// Should not reach here
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.message).toContain("fatal: branch already exists");
			expect(wtErr.worktreePath).toBe("/repo/.overstory/worktrees/auth-login");
			expect(wtErr.branchName).toBe("overstory/auth-login/bead-abc123");
		}
	});
});

describe("listWorktrees", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("parses porcelain output with multiple entries", async () => {
		const porcelainOutput = [
			"worktree /repo",
			"HEAD abc123def456",
			"branch refs/heads/main",
			"",
			"worktree /repo/.overstory/worktrees/auth-login",
			"HEAD def456abc789",
			"branch refs/heads/overstory/auth-login/bead-abc",
			"",
			"worktree /repo/.overstory/worktrees/data-sync",
			"HEAD 789abcdef012",
			"branch refs/heads/overstory/data-sync/bead-xyz",
		].join("\n");

		spawnSpy.mockImplementation(() => mockSpawnResult(porcelainOutput, "", 0));

		const entries = await listWorktrees("/repo");

		expect(entries).toHaveLength(3);

		expect(entries[0]?.path).toBe("/repo");
		expect(entries[0]?.head).toBe("abc123def456");
		expect(entries[0]?.branch).toBe("main");

		expect(entries[1]?.path).toBe("/repo/.overstory/worktrees/auth-login");
		expect(entries[1]?.head).toBe("def456abc789");
		expect(entries[1]?.branch).toBe("overstory/auth-login/bead-abc");

		expect(entries[2]?.path).toBe("/repo/.overstory/worktrees/data-sync");
		expect(entries[2]?.head).toBe("789abcdef012");
		expect(entries[2]?.branch).toBe("overstory/data-sync/bead-xyz");
	});

	test("strips refs/heads/ prefix from branch names", async () => {
		const porcelainOutput = [
			"worktree /repo",
			"HEAD abc123",
			"branch refs/heads/feature/my-branch",
		].join("\n");

		spawnSpy.mockImplementation(() => mockSpawnResult(porcelainOutput, "", 0));

		const entries = await listWorktrees("/repo");

		expect(entries).toHaveLength(1);
		expect(entries[0]?.branch).toBe("feature/my-branch");
	});

	test("handles empty output", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const entries = await listWorktrees("/repo");

		expect(entries).toHaveLength(0);
	});

	test("throws WorktreeError on git failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "fatal: not a git repository", 128));

		await expect(listWorktrees("/not-a-repo")).rejects.toThrow(WorktreeError);
	});

	test("passes correct args to git worktree list --porcelain", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await listWorktrees("/repo");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["git", "worktree", "list", "--porcelain"]);
	});
});

describe("removeWorktree", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls listWorktrees, then worktree remove, then branch -d", async () => {
		const porcelainOutput = [
			"worktree /repo/.overstory/worktrees/auth-login",
			"HEAD def456abc789",
			"branch refs/heads/overstory/auth-login/bead-abc",
		].join("\n");

		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// listWorktrees: git worktree list --porcelain
				return mockSpawnResult(porcelainOutput, "", 0);
			}
			if (callCount === 2) {
				// removeWorktree: git worktree remove
				return mockSpawnResult("", "", 0);
			}
			// branch -d
			return mockSpawnResult("", "", 0);
		});

		await removeWorktree("/repo", "/repo/.overstory/worktrees/auth-login");

		expect(spawnSpy).toHaveBeenCalledTimes(3);

		// First call: list worktrees
		const listArgs = (spawnSpy.mock.calls[0] as unknown[])[0] as string[];
		expect(listArgs).toEqual(["git", "worktree", "list", "--porcelain"]);

		// Second call: remove worktree
		const removeArgs = (spawnSpy.mock.calls[1] as unknown[])[0] as string[];
		expect(removeArgs).toEqual([
			"git",
			"worktree",
			"remove",
			"/repo/.overstory/worktrees/auth-login",
		]);

		// Third call: delete branch
		const branchArgs = (spawnSpy.mock.calls[2] as unknown[])[0] as string[];
		expect(branchArgs).toEqual(["git", "branch", "-d", "overstory/auth-login/bead-abc"]);
	});

	test("ignores branch deletion failure (unmerged branch)", async () => {
		const porcelainOutput = [
			"worktree /repo/.overstory/worktrees/auth-login",
			"HEAD def456abc789",
			"branch refs/heads/overstory/auth-login/bead-abc",
		].join("\n");

		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// listWorktrees
				return mockSpawnResult(porcelainOutput, "", 0);
			}
			if (callCount === 2) {
				// worktree remove - success
				return mockSpawnResult("", "", 0);
			}
			// branch -d - fails because branch is not merged
			return mockSpawnResult(
				"",
				"error: the branch 'overstory/auth-login/bead-abc' is not fully merged",
				1,
			);
		});

		// Should NOT throw despite the branch -d failure
		await removeWorktree("/repo", "/repo/.overstory/worktrees/auth-login");
	});

	test("throws WorktreeError when worktree remove fails", async () => {
		const porcelainOutput = [
			"worktree /repo/.overstory/worktrees/auth-login",
			"HEAD def456abc789",
			"branch refs/heads/overstory/auth-login/bead-abc",
		].join("\n");

		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// listWorktrees
				return mockSpawnResult(porcelainOutput, "", 0);
			}
			// worktree remove - failure
			return mockSpawnResult("", "fatal: cannot remove", 128);
		});

		await expect(removeWorktree("/repo", "/repo/.overstory/worktrees/auth-login")).rejects.toThrow(
			WorktreeError,
		);
	});

	test("skips branch deletion when worktree path is not found in list", async () => {
		// Empty worktree list - path won't be found
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await removeWorktree("/repo", "/repo/.overstory/worktrees/unknown");

		// Calls: listWorktrees (1) + worktree remove (2) = 2 total
		// No branch -d because branch is empty string
		expect(spawnSpy).toHaveBeenCalledTimes(2);
	});
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import { AgentError } from "../errors.ts";
import { type BeadIssue, type BeadsClient, createBeadsClient } from "./client.ts";

/**
 * Helper to extract the command array from a Bun.spawn spy call.
 * Handles noUncheckedIndexedAccess by using optional chaining.
 */
function getSpawnCmd(spy: ReturnType<typeof spyOn>, callIndex = 0): string[] {
	const call = spy.mock.calls[callIndex];
	if (!call) {
		throw new Error(`No call at index ${callIndex}`);
	}
	return call[0] as string[];
}

/**
 * Helper to extract spawn options from a Bun.spawn spy call.
 */
function getSpawnOptions(spy: ReturnType<typeof spyOn>, callIndex = 0): { cwd: string } {
	const call = spy.mock.calls[callIndex];
	if (!call) {
		throw new Error(`No call at index ${callIndex}`);
	}
	return call[1] as { cwd: string };
}

/**
 * Helper to create a mock Bun.spawn return value.
 * Returns an object shaped like a Subprocess with piped stdout/stderr.
 */
function mockSpawnResult(stdout: string, stderr: string, exitCode: number): Partial<Subprocess> {
	const stdoutBody = new Response(stdout).body;
	const stderrBody = new Response(stderr).body;
	return {
		stdout: stdoutBody ?? undefined,
		stderr: stderrBody ?? undefined,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

const sampleIssue: BeadIssue = {
	id: "test-1",
	title: "Test Issue",
	status: "open",
	priority: 2,
	type: "task",
};

const sampleIssueList: BeadIssue[] = [
	sampleIssue,
	{
		id: "test-2",
		title: "Another Issue",
		status: "open",
		priority: 1,
		type: "bug",
	},
];

describe("createBeadsClient", () => {
	let client: BeadsClient;
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		client = createBeadsClient("/fake/project");
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	describe("ready", () => {
		test("returns parsed issues from bd ready --json", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssueList), "", 0) as Subprocess,
			);

			const issues = await client.ready();

			expect(issues).toHaveLength(2);
			expect(issues[0]?.id).toBe("test-1");
			expect(issues[1]?.id).toBe("test-2");

			// Verify correct command was called
			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "ready", "--json"]);
		});

		test("passes --mol flag when option provided", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssueList), "", 0) as Subprocess,
			);

			await client.ready({ mol: "core" });

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "ready", "--json", "--mol", "core"]);
		});
	});

	describe("show", () => {
		test("returns a single parsed issue", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssue), "", 0) as Subprocess,
			);

			const issue = await client.show("test-1");

			expect(issue.id).toBe("test-1");
			expect(issue.title).toBe("Test Issue");
			expect(issue.status).toBe("open");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "show", "test-1", "--json"]);
		});
	});

	describe("create", () => {
		test("returns new issue id from bd create", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify({ id: "new-issue-1" }), "", 0) as Subprocess,
			);

			const id = await client.create("New Feature");

			expect(id).toBe("new-issue-1");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "create", "New Feature", "--json"]);
		});

		test("passes all option flags correctly", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify({ id: "new-issue-2" }), "", 0) as Subprocess,
			);

			await client.create("Bug Fix", {
				type: "bug",
				priority: 1,
				description: "Critical fix needed",
			});

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual([
				"bd",
				"create",
				"Bug Fix",
				"--json",
				"--type",
				"bug",
				"--priority",
				"1",
				"--description",
				"Critical fix needed",
			]);
		});

		test("only passes provided options, omits undefined ones", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify({ id: "new-issue-3" }), "", 0) as Subprocess,
			);

			await client.create("Task", { type: "task" });

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "create", "Task", "--json", "--type", "task"]);
		});
	});

	describe("claim", () => {
		test("runs bd update with in_progress status", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0) as Subprocess);

			await client.claim("test-1");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "update", "test-1", "--status", "in_progress"]);
		});

		test("returns void on success", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0) as Subprocess);

			const result = await client.claim("test-1");
			expect(result).toBeUndefined();
		});
	});

	describe("close", () => {
		test("runs bd close without reason", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0) as Subprocess);

			await client.close("test-1");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "close", "test-1"]);
		});

		test("runs bd close with --reason flag when provided", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0) as Subprocess);

			await client.close("test-1", "Completed all acceptance criteria");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual([
				"bd",
				"close",
				"test-1",
				"--reason",
				"Completed all acceptance criteria",
			]);
		});
	});

	describe("list", () => {
		test("returns parsed issues from bd list --json", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssueList), "", 0) as Subprocess,
			);

			const issues = await client.list();

			expect(issues).toHaveLength(2);
			expect(issues[0]?.id).toBe("test-1");

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "list", "--json"]);
		});

		test("passes --status filter", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify([sampleIssue]), "", 0) as Subprocess,
			);

			await client.list({ status: "open" });

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "list", "--json", "--status", "open"]);
		});

		test("passes --limit filter", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify([sampleIssue]), "", 0) as Subprocess,
			);

			await client.list({ limit: 5 });

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "list", "--json", "--limit", "5"]);
		});

		test("passes both --status and --limit filters", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssueList), "", 0) as Subprocess,
			);

			await client.list({ status: "in_progress", limit: 10 });

			const cmd = getSpawnCmd(spawnSpy);
			expect(cmd).toEqual(["bd", "list", "--json", "--status", "in_progress", "--limit", "10"]);
		});
	});

	describe("error handling", () => {
		test("throws AgentError on non-zero exit code", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult("", "bd: issue not found", 1) as Subprocess,
			);

			await expect(client.show("nonexistent")).rejects.toThrow(AgentError);
		});

		test("includes stderr in AgentError message", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult("", "bd: permission denied", 1) as Subprocess,
			);

			try {
				await client.ready();
				// Should not reach here
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(AgentError);
				expect((err as AgentError).message).toContain("permission denied");
			}
		});

		test("throws AgentError on empty stdout for JSON commands", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0) as Subprocess);

			await expect(client.ready()).rejects.toThrow(AgentError);
		});

		test("throws AgentError on empty stdout with whitespace", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("   \n  ", "", 0) as Subprocess);

			await expect(client.show("test-1")).rejects.toThrow(AgentError);
		});

		test("throws AgentError on malformed JSON", async () => {
			spawnSpy.mockImplementation(() => mockSpawnResult("{not valid json", "", 0) as Subprocess);

			await expect(client.list()).rejects.toThrow(AgentError);
		});

		test("AgentError on malformed JSON includes truncated output", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult("this is not json at all", "", 0) as Subprocess,
			);

			try {
				await client.ready();
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(AgentError);
				expect((err as AgentError).message).toContain("Failed to parse JSON");
				expect((err as AgentError).message).toContain("this is not json at all");
			}
		});
	});

	describe("cwd propagation", () => {
		test("passes cwd to Bun.spawn", async () => {
			spawnSpy.mockImplementation(
				() => mockSpawnResult(JSON.stringify(sampleIssueList), "", 0) as Subprocess,
			);

			await client.ready();

			const options = getSpawnOptions(spawnSpy);
			expect(options.cwd).toBe("/fake/project");
		});
	});
});

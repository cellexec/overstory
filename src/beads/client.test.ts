import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { AgentError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { type BeadsClient, createBeadsClient } from "./client.ts";

/**
 * Check if the bd CLI is available on this machine (synchronous).
 * Uses Bun.spawnSync so the result is available at test registration time
 * for use with test.skipIf().
 */
function isBdAvailable(): boolean {
	try {
		const result = Bun.spawnSync(["bd", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Initialize beads in a git repo directory.
 */
async function initBeads(cwd: string): Promise<void> {
	const proc = Bun.spawn(["bd", "init"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`bd init failed: ${stderr}`);
	}
}

const bdAvailable = isBdAvailable();

describe("createBeadsClient (integration)", () => {
	let tempDir: string;
	let client: BeadsClient;

	beforeEach(async () => {
		if (!bdAvailable) return;
		// realpathSync resolves macOS /var -> /private/var symlink so paths match
		tempDir = realpathSync(await createTempGitRepo());
		await initBeads(tempDir);
		client = createBeadsClient(tempDir);
	});

	afterEach(async () => {
		if (!bdAvailable) return;
		await cleanupTempDir(tempDir);
	});

	describe("create", () => {
		test.skipIf(!bdAvailable)("returns an issue ID", async () => {
			const id = await client.create("Integration test issue");

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});

		test.skipIf(!bdAvailable)("returns ID with type and priority options", async () => {
			const id = await client.create("Typed issue", {
				type: "bug",
				priority: 1,
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});

		test.skipIf(!bdAvailable)("returns ID with description option", async () => {
			const id = await client.create("Described issue", {
				description: "A detailed description",
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});
	});

	describe("show", () => {
		test.skipIf(!bdAvailable)("returns issue details for a valid ID", async () => {
			const id = await client.create("Show test issue", {
				type: "task",
				priority: 2,
			});

			const issue = await client.show(id);

			expect(issue.id).toBe(id);
			expect(issue.title).toBe("Show test issue");
			expect(issue.status).toBe("open");
			expect(issue.priority).toBe(2);
			expect(issue.type).toBe("task");
		});
	});

	describe("claim", () => {
		test.skipIf(!bdAvailable)("changes issue status to in_progress", async () => {
			const id = await client.create("Claim test issue");

			await client.claim(id);

			const issue = await client.show(id);
			expect(issue.status).toBe("in_progress");
		});

		test.skipIf(!bdAvailable)("returns void on success", async () => {
			const id = await client.create("Claim void test");

			const result = await client.claim(id);
			expect(result).toBeUndefined();
		});
	});

	describe("close", () => {
		test.skipIf(!bdAvailable)("closes an issue without reason", async () => {
			const id = await client.create("Close test issue");

			await client.close(id);

			const issue = await client.show(id);
			expect(issue.status).toBe("closed");
		});

		test.skipIf(!bdAvailable)("closes an issue with a reason", async () => {
			const id = await client.create("Close reason test");

			await client.close(id, "Completed all acceptance criteria");

			const issue = await client.show(id);
			expect(issue.status).toBe("closed");
		});
	});

	describe("list", () => {
		test.skipIf(!bdAvailable)("returns all issues", async () => {
			await client.create("List issue 1");
			await client.create("List issue 2");

			const issues = await client.list();

			expect(issues.length).toBeGreaterThanOrEqual(2);
			const titles = issues.map((i) => i.title);
			expect(titles).toContain("List issue 1");
			expect(titles).toContain("List issue 2");
		});

		test.skipIf(!bdAvailable)("filters by status", async () => {
			const id1 = await client.create("Open issue");
			const id2 = await client.create("Claimed issue");
			await client.claim(id2);

			const openIssues = await client.list({ status: "open" });
			const openIds = openIssues.map((i) => i.id);
			expect(openIds).toContain(id1);
			expect(openIds).not.toContain(id2);

			const inProgressIssues = await client.list({ status: "in_progress" });
			const inProgressIds = inProgressIssues.map((i) => i.id);
			expect(inProgressIds).toContain(id2);
			expect(inProgressIds).not.toContain(id1);
		});

		test.skipIf(!bdAvailable)("respects limit option", async () => {
			await client.create("Limit issue 1");
			await client.create("Limit issue 2");
			await client.create("Limit issue 3");

			const limited = await client.list({ limit: 1 });
			expect(limited).toHaveLength(1);
		});
	});

	describe("ready", () => {
		test.skipIf(!bdAvailable)("returns open unblocked issues", async () => {
			const id = await client.create("Ready issue");

			const readyIssues = await client.ready();

			const readyIds = readyIssues.map((i) => i.id);
			expect(readyIds).toContain(id);
		});

		test.skipIf(!bdAvailable)("does not return in_progress issues", async () => {
			const id = await client.create("Claimed ready issue");
			await client.claim(id);

			const readyIssues = await client.ready();

			const readyIds = readyIssues.map((i) => i.id);
			expect(readyIds).not.toContain(id);
		});

		test.skipIf(!bdAvailable)("does not return closed issues", async () => {
			const id = await client.create("Closed ready issue");
			await client.close(id);

			const readyIssues = await client.ready();

			const readyIds = readyIssues.map((i) => i.id);
			expect(readyIds).not.toContain(id);
		});
	});

	describe("error handling", () => {
		test.skipIf(!bdAvailable)("show throws AgentError for nonexistent ID", async () => {
			await expect(client.show("nonexistent-id")).rejects.toThrow(AgentError);
		});

		test.skipIf(!bdAvailable)(
			"throws AgentError when bd is run without beads initialized",
			async () => {
				// Create a git repo without bd init
				const bareDir = realpathSync(await createTempGitRepo());
				const bareClient = createBeadsClient(bareDir);

				try {
					await expect(bareClient.list()).rejects.toThrow(AgentError);
				} finally {
					await cleanupTempDir(bareDir);
				}
			},
		);
	});
});

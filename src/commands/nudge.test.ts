import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types.ts";

/**
 * Tests for the nudge command's debounce and session lookup logic.
 *
 * We test the pure/file-based functions directly rather than the full
 * nudgeCommand (which requires real tmux sessions). Tmux interaction
 * is tested via E2E.
 */

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "nudge-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Helper to write a sessions.json for testing.
 */
async function writeSessions(projectRoot: string, sessions: AgentSession[]): Promise<void> {
	const dir = join(projectRoot, ".overstory");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
	await Bun.write(join(dir, "sessions.json"), `${JSON.stringify(sessions, null, "\t")}\n`);
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-123-test-agent",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/wt",
		branchName: "overstory/test-agent/task-1",
		beadId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

describe("nudgeAgent", () => {
	// We dynamically import to avoid circular issues
	async function importNudge() {
		return await import("./nudge.ts");
	}

	test("returns error when no active session exists", async () => {
		await writeSessions(tempDir, []);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "nonexistent-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("returns error when agent is zombie", async () => {
		await writeSessions(tempDir, [makeSession({ state: "zombie" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("returns error when agent is completed", async () => {
		await writeSessions(tempDir, [makeSession({ state: "completed" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("finds active agent in working state", async () => {
		await writeSessions(tempDir, [makeSession({ state: "working" })]);
		const { nudgeAgent } = await importNudge();
		// This will fail on sendKeys (no real tmux) but should get past session lookup
		const result = await nudgeAgent(tempDir, "test-agent");
		// Will fail because tmux session doesn't exist, but we validated session lookup works
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
	});

	test("finds active agent in booting state", async () => {
		await writeSessions(tempDir, [makeSession({ state: "booting" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
	});

	test("handles missing sessions.json gracefully", async () => {
		// No sessions.json at all
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});
});

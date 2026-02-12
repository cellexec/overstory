import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../errors.ts";
import { createSession, isSessionAlive, killSession, listSessions, sendKeys } from "./tmux.ts";

/**
 * tmux tests use Bun.spawn mocks — legitimate exception to "never mock what you can use for real".
 * Real tmux operations would hijack the developer's session and are unavailable in CI.
 */

/**
 * Helper to create a mock Bun.spawn return value.
 *
 * The actual code reads stdout/stderr via `new Response(proc.stdout).text()`
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

describe("createSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("creates session and returns pane PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory — return a bin path
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// tmux list-panes -t overstory-auth -F '#{pane_pid}'
			return mockSpawnResult("42\n", "", 0);
		});

		const pid = await createSession(
			"overstory-auth",
			"/repo/worktrees/auth",
			"claude --task 'do work'",
		);

		expect(pid).toBe(42);
	});

	test("passes correct args to tmux new-session with PATH wrapping", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("1234\n", "", 0);
		});

		await createSession("my-session", "/work/dir", "echo hello");

		// Call 0 is 'which overstory', call 1 is 'tmux new-session'
		const tmuxCallArgs = spawnSpy.mock.calls[1] as unknown[];
		const cmd = tmuxCallArgs[0] as string[];
		expect(cmd[0]).toBe("tmux");
		expect(cmd[1]).toBe("new-session");
		expect(cmd[3]).toBe("-s");
		expect(cmd[4]).toBe("my-session");
		expect(cmd[5]).toBe("-c");
		expect(cmd[6]).toBe("/work/dir");
		// The command should be wrapped with PATH export
		const wrappedCmd = cmd[7] as string;
		expect(wrappedCmd).toContain("echo hello");
		expect(wrappedCmd).toContain("export PATH=");

		const opts = tmuxCallArgs[1] as { cwd: string };
		expect(opts.cwd).toBe("/work/dir");
	});

	test("calls list-panes after creating to get pane PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("7777\n", "", 0);
		});

		await createSession("test-agent", "/tmp", "ls");

		// 3 calls: which overstory, tmux new-session, tmux list-panes
		expect(spawnSpy).toHaveBeenCalledTimes(3);
		const thirdCallArgs = spawnSpy.mock.calls[2] as unknown[];
		const cmd = thirdCallArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "list-panes", "-t", "test-agent", "-F", "#{pane_pid}"]);
	});

	test("throws AgentError if session creation fails", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			return mockSpawnResult("", "duplicate session: my-session", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if list-panes fails after creation", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// new-session succeeds
				return mockSpawnResult("", "", 0);
			}
			// list-panes fails
			return mockSpawnResult("", "error listing panes", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if pane PID output is empty", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			// list-panes returns empty output
			return mockSpawnResult("", "", 0);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("AgentError includes session name context", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			return mockSpawnResult("", "duplicate session: agent-foo", 1);
		});

		try {
			await createSession("agent-foo", "/tmp", "ls");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("agent-foo");
			expect(agentErr.agentName).toBe("agent-foo");
		}
	});

	test("still creates session when which overstory fails (uses fallback)", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory fails
				return mockSpawnResult("", "overstory not found", 1);
			}
			if (callCount === 2) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// tmux list-panes
			return mockSpawnResult("5555\n", "", 0);
		});

		const pid = await createSession("fallback-agent", "/tmp", "echo test");
		expect(pid).toBe(5555);

		// The tmux command should contain the original command
		const tmuxCallArgs = spawnSpy.mock.calls[1] as unknown[];
		const cmd = tmuxCallArgs[0] as string[];
		const tmuxCmd = cmd[7] as string;
		expect(tmuxCmd).toContain("echo test");
	});
});

describe("listSessions", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("parses session list output", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("overstory-auth:42\noverstory-data:99\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.name).toBe("overstory-auth");
		expect(sessions[0]?.pid).toBe(42);
		expect(sessions[1]?.name).toBe("overstory-data");
		expect(sessions[1]?.pid).toBe(99);
	});

	test("returns empty array when no server running", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("", "no server running on /tmp/tmux-501/default", 1),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("returns empty array when 'no sessions' in stderr", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "no sessions", 1));

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("throws AgentError on other tmux failures", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "protocol version mismatch", 1));

		await expect(listSessions()).rejects.toThrow(AgentError);
	});

	test("skips malformed lines", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("valid-session:123\nmalformed-no-colon\n:no-name\n\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("valid-session");
		expect(sessions[0]?.pid).toBe(123);
	});

	test("passes correct args to tmux", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await listSessions();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "list-sessions", "-F", "#{session_name}:#{pid}"]);
	});
});

describe("killSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls tmux kill-session with correct args", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await killSession("overstory-auth");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "kill-session", "-t", "overstory-auth"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: nonexistent", 1));

		await expect(killSession("nonexistent")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: ghost-agent", 1));

		try {
			await killSession("ghost-agent");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("ghost-agent");
			expect(agentErr.agentName).toBe("ghost-agent");
		}
	});
});

describe("isSessionAlive", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns true when session exists (exit 0)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const alive = await isSessionAlive("overstory-auth");

		expect(alive).toBe(true);
	});

	test("returns false when session does not exist (non-zero exit)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find session: nonexistent", 1));

		const alive = await isSessionAlive("nonexistent");

		expect(alive).toBe(false);
	});

	test("passes correct args to tmux has-session", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await isSessionAlive("my-agent");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "has-session", "-t", "my-agent"]);
	});
});

describe("sendKeys", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("passes correct args to tmux send-keys", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await sendKeys("overstory-auth", "echo hello world");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "send-keys", "-t", "overstory-auth", "echo hello world", "Enter"]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: dead-agent", 1));

		await expect(sendKeys("dead-agent", "echo test")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: my-agent", 1));

		try {
			await sendKeys("my-agent", "test command");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("my-agent");
			expect(agentErr.agentName).toBe("my-agent");
		}
	});
});

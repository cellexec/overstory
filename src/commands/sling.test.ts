import { describe, expect, test } from "bun:test";
import { calculateStaggerDelay } from "./sling.ts";

/**
 * Tests for the stagger delay enforcement in the sling command (step 4b).
 *
 * The stagger delay logic prevents rapid-fire agent spawning by requiring
 * a minimum delay between consecutive spawns. If the most recently started
 * active session was spawned less than staggerDelayMs ago, the sling command
 * sleeps for the remaining time.
 *
 * calculateStaggerDelay is a pure function that returns the number of
 * milliseconds to sleep (0 if no delay is needed). The sling command calls
 * Bun.sleep with the returned value if it's greater than 0.
 */

// --- Helpers ---

function makeSession(startedAt: string): { startedAt: string } {
	return { startedAt };
}

describe("calculateStaggerDelay", () => {
	test("returns remaining delay when a recent session exists", () => {
		const now = Date.now();
		// Session started 500ms ago, stagger delay is 2000ms -> should return ~1500ms
		const sessions = [makeSession(new Date(now - 500).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_500);
	});

	test("returns 0 when staggerDelayMs is 0", () => {
		const now = Date.now();
		// Even with a very recent session, delay of 0 means no stagger
		const sessions = [makeSession(new Date(now - 100).toISOString())];

		const delay = calculateStaggerDelay(0, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns 0 when no active sessions exist", () => {
		const now = Date.now();

		const delay = calculateStaggerDelay(5_000, [], now);

		expect(delay).toBe(0);
	});

	test("returns 0 when enough time has already elapsed", () => {
		const now = Date.now();
		// Session started 10 seconds ago, stagger delay is 2 seconds -> no delay
		const sessions = [makeSession(new Date(now - 10_000).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns 0 when elapsed time exactly equals stagger delay", () => {
		const now = Date.now();
		// Session started exactly 2000ms ago, stagger delay is 2000ms -> remaining = 0
		const sessions = [makeSession(new Date(now - 2_000).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("uses the most recent session for calculation with multiple sessions", () => {
		const now = Date.now();
		// Two sessions: one old (5s ago), one recent (200ms ago)
		// With staggerDelayMs=2000, delay should be based on the 200ms-old session
		const sessions = [
			makeSession(new Date(now - 5_000).toISOString()),
			makeSession(new Date(now - 200).toISOString()),
		];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_800);
	});

	test("handles sessions in any order (most recent is not last)", () => {
		const now = Date.now();
		// Most recent session is first in the array
		const sessions = [
			makeSession(new Date(now - 300).toISOString()),
			makeSession(new Date(now - 5_000).toISOString()),
			makeSession(new Date(now - 10_000).toISOString()),
		];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_700);
	});

	test("returns 0 when staggerDelayMs is negative", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 100).toISOString())];

		const delay = calculateStaggerDelay(-1_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns full delay when session was just started (elapsed ~0)", () => {
		const now = Date.now();
		// Session started at exactly now
		const sessions = [makeSession(new Date(now).toISOString())];

		const delay = calculateStaggerDelay(3_000, sessions, now);

		expect(delay).toBe(3_000);
	});

	test("handles a single session correctly", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 1_000).toISOString())];

		const delay = calculateStaggerDelay(5_000, sessions, now);

		expect(delay).toBe(4_000);
	});

	test("handles large stagger delay values", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 1_000).toISOString())];

		const delay = calculateStaggerDelay(60_000, sessions, now);

		expect(delay).toBe(59_000);
	});

	test("all sessions old enough means no delay, regardless of count", () => {
		const now = Date.now();
		// Many sessions, but all started well before the stagger window
		const sessions = [
			makeSession(new Date(now - 30_000).toISOString()),
			makeSession(new Date(now - 25_000).toISOString()),
			makeSession(new Date(now - 20_000).toISOString()),
			makeSession(new Date(now - 15_000).toISOString()),
		];

		const delay = calculateStaggerDelay(5_000, sessions, now);

		expect(delay).toBe(0);
	});
});

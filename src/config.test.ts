import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { ValidationError } from "./errors.ts";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeConfig(yaml: string): Promise<void> {
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(join(overstoryDir, "config.yaml"), yaml);
	}

	async function ensureOverstoryDir(): Promise<void> {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	}

	test("returns defaults when no config file exists", async () => {
		const config = await loadConfig(tempDir);

		expect(config.project.root).toBe(tempDir);
		expect(config.project.canonicalBranch).toBe("main");
		expect(config.agents.maxConcurrent).toBe(5);
		expect(config.agents.maxDepth).toBe(2);
		expect(config.beads.enabled).toBe(true);
		expect(config.mulch.enabled).toBe(true);
		expect(config.mulch.primeFormat).toBe("markdown");
		expect(config.logging.verbose).toBe(false);
	});

	test("sets project.name from directory name", async () => {
		const config = await loadConfig(tempDir);
		const parts = tempDir.split("/");
		const expectedName = parts[parts.length - 1] ?? "unknown";
		expect(config.project.name).toBe(expectedName);
	});

	test("merges config file values over defaults", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: develop
agents:
  maxConcurrent: 10
`);

		const config = await loadConfig(tempDir);

		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(10);
		// Non-overridden values keep defaults
		expect(config.agents.maxDepth).toBe(2);
		expect(config.beads.enabled).toBe(true);
	});

	test("always sets project.root to the actual projectRoot", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  root: /some/wrong/path
`);

		const config = await loadConfig(tempDir);
		expect(config.project.root).toBe(tempDir);
	});

	test("parses boolean values correctly", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
beads:
  enabled: false
mulch:
  enabled: true
logging:
  verbose: true
  redactSecrets: false
`);

		const config = await loadConfig(tempDir);

		expect(config.beads.enabled).toBe(false);
		expect(config.mulch.enabled).toBe(true);
		expect(config.logging.verbose).toBe(true);
		expect(config.logging.redactSecrets).toBe(false);
	});

	test("parses empty array literal", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
mulch:
  domains: []
`);

		const config = await loadConfig(tempDir);
		expect(config.mulch.domains).toEqual([]);
	});

	test("parses numeric values including underscore-separated", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
agents:
  staggerDelayMs: 5000
watchdog:
  tier1IntervalMs: 60000
  staleThresholdMs: 120000
  zombieThresholdMs: 300000
`);

		const config = await loadConfig(tempDir);
		expect(config.agents.staggerDelayMs).toBe(5000);
		expect(config.watchdog.tier1IntervalMs).toBe(60000);
	});

	test("handles quoted string values", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: "develop"
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("ignores comments and empty lines", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
# This is a comment
project:
  canonicalBranch: develop  # inline comment

  # Another comment
agents:
  maxConcurrent: 3
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(3);
	});
});

describe("validateConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeConfig(yaml: string): Promise<void> {
		await Bun.write(join(tempDir, ".overstory", "config.yaml"), yaml);
	}

	test("rejects negative maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects zero maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative maxDepth", async () => {
		await writeConfig(`
agents:
  maxDepth: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative staggerDelayMs", async () => {
		await writeConfig(`
agents:
  staggerDelayMs: -100
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects invalid mulch.primeFormat", async () => {
		await writeConfig(`
mulch:
  primeFormat: yaml
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects zombieThresholdMs <= staleThresholdMs", async () => {
		await writeConfig(`
watchdog:
  staleThresholdMs: 300000
  zombieThresholdMs: 300000
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects non-positive tier1IntervalMs when tier1 is enabled", async () => {
		await writeConfig(`
watchdog:
  tier1Enabled: true
  tier1IntervalMs: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});
});

describe("DEFAULT_CONFIG", () => {
	test("has all required top-level keys", () => {
		expect(DEFAULT_CONFIG.project).toBeDefined();
		expect(DEFAULT_CONFIG.agents).toBeDefined();
		expect(DEFAULT_CONFIG.worktrees).toBeDefined();
		expect(DEFAULT_CONFIG.beads).toBeDefined();
		expect(DEFAULT_CONFIG.mulch).toBeDefined();
		expect(DEFAULT_CONFIG.merge).toBeDefined();
		expect(DEFAULT_CONFIG.watchdog).toBeDefined();
		expect(DEFAULT_CONFIG.logging).toBeDefined();
	});

	test("has sensible default values", () => {
		expect(DEFAULT_CONFIG.project.canonicalBranch).toBe("main");
		expect(DEFAULT_CONFIG.agents.maxConcurrent).toBe(5);
		expect(DEFAULT_CONFIG.agents.maxDepth).toBe(2);
		expect(DEFAULT_CONFIG.agents.staggerDelayMs).toBe(2_000);
		expect(DEFAULT_CONFIG.watchdog.tier1IntervalMs).toBe(30_000);
		expect(DEFAULT_CONFIG.watchdog.staleThresholdMs).toBe(300_000);
		expect(DEFAULT_CONFIG.watchdog.zombieThresholdMs).toBe(600_000);
	});
});

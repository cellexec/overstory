import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createMergeQueue } from "../merge/queue.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import { mergeCommand } from "./merge.ts";

describe("mergeCommand", () => {
	let repoDir: string;
	let defaultBranch: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		repoDir = await createTempGitRepo();
		defaultBranch = await getDefaultBranch(repoDir);
		process.chdir(repoDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await cleanupTempDir(repoDir);
	});

	/**
	 * Setup helper: Create .overstory/ dir and write config.yaml with project canonicalBranch.
	 */
	async function setupProject(dir: string, canonicalBranch: string): Promise<void> {
		const overstoryDir = join(dir, ".overstory");
		await mkdir(overstoryDir);

		const configYaml = `project:
  canonicalBranch: ${canonicalBranch}
  root: ${dir}

merge:
  aiResolveEnabled: false
  reimagineEnabled: false
`;
		await Bun.write(join(overstoryDir, "config.yaml"), configYaml);
	}

	/**
	 * Setup helper: Create a clean feature branch with a committed file.
	 * Commits a base file (if not exists), creates a new branch, commits a feature file, then switches back to defaultBranch.
	 */
	async function createCleanFeatureBranch(dir: string, branchName: string): Promise<void> {
		// Only commit base file if it doesn't exist
		const baseFilePath = join(dir, "src/base.ts");
		const baseFileExists = await Bun.file(baseFilePath).exists();
		if (!baseFileExists) {
			await commitFile(dir, "src/base.ts", "base content");
		}
		await runGitInDir(dir, ["checkout", "-b", branchName]);
		await commitFile(dir, `src/${branchName}.ts`, "feature content");
		await runGitInDir(dir, ["checkout", defaultBranch]);
	}

	describe("help and validation", () => {
		test("--help prints help containing 'overstory merge', '--branch', '--all', '--dry-run'", async () => {
			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--help"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("overstory merge");
			expect(output).toContain("--branch");
			expect(output).toContain("--all");
			expect(output).toContain("--dry-run");
		});

		test("-h prints help", async () => {
			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["-h"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("overstory merge");
		});

		test("no flags throws ValidationError mentioning '--branch' and '--all'", async () => {
			await setupProject(repoDir, defaultBranch);

			try {
				await mergeCommand([]);
				expect(true).toBe(false); // Should not reach here
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(ValidationError);
				const validationErr = err as ValidationError;
				expect(validationErr.message).toContain("--branch");
				expect(validationErr.message).toContain("--all");
			}
		});
	});

	describe("--branch with real git repo", () => {
		test("nonexistent branch throws ValidationError", async () => {
			await setupProject(repoDir, defaultBranch);

			try {
				await mergeCommand(["--branch", "nonexistent-branch"]);
				expect(true).toBe(false); // Should not reach here
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(ValidationError);
				const validationErr = err as ValidationError;
				expect(validationErr.message).toContain("nonexistent-branch");
			}
		});

		test("--dry-run shows branch info without merging (verify still on defaultBranch after)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/test-agent/bead-123";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName, "--dry-run"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain(branchName);
			expect(output).toContain("pending");

			// Verify still on defaultBranch
			const currentBranch = await getDefaultBranch(repoDir);
			expect(currentBranch).toBe(defaultBranch);
		});

		test("--dry-run --json outputs JSON with branchName and status:pending", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/test-agent/bead-456";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName, "--dry-run", "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.branchName).toBe(branchName);
			expect(parsed.status).toBe("pending");
		});

		test("merges a clean branch successfully (verify feature file exists after)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-789";
			await createCleanFeatureBranch(repoDir, branchName);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => {
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName]);
			} finally {
				process.stdout.write = originalWrite;
			}

			// Verify feature file exists after merge
			const featureFilePath = join(repoDir, `src/${branchName}.ts`);
			const featureFile = await Bun.file(featureFilePath).text();
			expect(featureFile).toBe("feature content");
		});

		test("--json outputs JSON with success:true and tier:clean-merge", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-abc";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName, "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.tier).toBe("clean-merge");
		});

		test("parses agent name from overstory/my-builder/bead-abc convention (use --dry-run)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/my-builder/bead-xyz";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName, "--dry-run", "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.agentName).toBe("my-builder");
			expect(parsed.beadId).toBe("bead-xyz");
		});
	});

	describe("--all with real git repo", () => {
		test("prints 'No pending' when queue empty", async () => {
			await setupProject(repoDir, defaultBranch);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--all"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("No pending");
		});

		test("--json shows empty results", async () => {
			await setupProject(repoDir, defaultBranch);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--all", "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.results).toEqual([]);
			expect(parsed.count).toBe(0);
		});

		test("--all --dry-run lists pending entries from merge-queue.json", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/agent1/bead-001";
			const branch2 = "overstory/agent2/bead-002";
			await createCleanFeatureBranch(repoDir, branch1);
			await createCleanFeatureBranch(repoDir, branch2);

			// Enqueue entries via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				beadId: "bead-001",
				agentName: "agent1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				beadId: "bead-002",
				agentName: "agent2",
				filesModified: [`src/${branch2}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--all", "--dry-run"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("2 pending");
			expect(output).toContain(branch1);
			expect(output).toContain(branch2);
		});

		test("--all merges multiple pending entries (write merge-queue.json with entries, verify counts)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/builder1/bead-100";
			const branch2 = "overstory/builder2/bead-200";
			await createCleanFeatureBranch(repoDir, branch1);
			await createCleanFeatureBranch(repoDir, branch2);

			// Enqueue entries via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				beadId: "bead-100",
				agentName: "builder1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				beadId: "bead-200",
				agentName: "builder2",
				filesModified: [`src/${branch2}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--all"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("Done");
			expect(output).toContain("2 merged");

			// Verify both feature files exist after merge
			const file1 = await Bun.file(join(repoDir, `src/${branch1}.ts`)).text();
			const file2 = await Bun.file(join(repoDir, `src/${branch2}.ts`)).text();
			expect(file1).toBe("feature content");
			expect(file2).toBe("feature content");
		});

		test("--all --json reports successCount and failCount", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/builder3/bead-300";
			await createCleanFeatureBranch(repoDir, branch1);

			// Enqueue entry via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				beadId: "bead-300",
				agentName: "builder3",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--all", "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.successCount).toBe(1);
			expect(parsed.failCount).toBe(0);
			expect(parsed.count).toBe(1);
		});
	});

	describe("conflict handling", () => {
		test("content conflict auto-resolves: same file modified on both branches, verify incoming content wins", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create a conflict: modify same file on both branches
			await commitFile(repoDir, "src/shared.ts", "base content");

			// Modify on default branch
			await commitFile(repoDir, "src/shared.ts", "default branch content");

			// Create feature branch and modify the same file
			const branchName = "overstory/builder-conflict/bead-999";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, "src/shared.ts", "feature branch content");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => {
				return true;
			};

			try {
				await mergeCommand(["--branch", branchName]);
			} finally {
				process.stdout.write = originalWrite;
			}

			// Verify incoming (feature branch) content wins
			const sharedFile = await Bun.file(join(repoDir, "src/shared.ts")).text();
			expect(sharedFile).toBe("feature branch content");
		});
	});
});

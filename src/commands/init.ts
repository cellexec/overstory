/**
 * CLI command: overstory init [--force]
 *
 * Scaffolds the `.overstory/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";

const OVERSTORY_DIR = ".overstory";

/**
 * Detect the project name from git or fall back to directory name.
 */
async function detectProjectName(root: string): Promise<string> {
	// Try git remote origin
	try {
		const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const url = (await new Response(proc.stdout).text()).trim();
			// Extract repo name from URL: git@host:user/repo.git or https://host/user/repo.git
			const match = url.match(/\/([^/]+?)(?:\.git)?$/);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		// Git not available or not a git repo
	}

	return basename(root);
}

/**
 * Detect the canonical branch name from git.
 */
async function detectCanonicalBranch(root: string): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const ref = (await new Response(proc.stdout).text()).trim();
			// refs/remotes/origin/main -> main
			const branch = ref.split("/").pop();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	// Fall back to checking current branch
	try {
		const proc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch === "main" || branch === "master" || branch === "develop") {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Serialize an OverstoryConfig to YAML format.
 *
 * Handles nested objects with indentation, scalar values,
 * arrays with `- item` syntax, and empty arrays as `[]`.
 */
function serializeConfigToYaml(config: OverstoryConfig): string {
	const lines: string[] = [];
	lines.push("# Overstory configuration");
	lines.push("# See: https://github.com/overstory/overstory");
	lines.push("");

	serializeObject(config as unknown as Record<string, unknown>, lines, 0);

	return `${lines.join("\n")}\n`;
}

/**
 * Recursively serialize an object to YAML lines.
 */
function serializeObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
	const indent = "  ".repeat(depth);

	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined) {
			lines.push(`${indent}${key}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${indent}${key}:`);
			serializeObject(value as Record<string, unknown>, lines, depth + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${indent}${key}: []`);
			} else {
				lines.push(`${indent}${key}:`);
				const itemIndent = "  ".repeat(depth + 1);
				for (const item of value) {
					lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
				}
			}
		} else {
			lines.push(`${indent}${key}: ${formatYamlValue(value)}`);
		}
	}
}

/**
 * Format a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		// Quote strings that could be misinterpreted
		if (
			value === "" ||
			value === "true" ||
			value === "false" ||
			value === "null" ||
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n") ||
			/^\d/.test(value)
		) {
			// Use double quotes, escaping inner double quotes
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null || value === undefined) {
		return "null";
	}

	return String(value);
}

/**
 * Build the starter agent manifest.
 */
function buildAgentManifest(): AgentManifest {
	return {
		version: "1.0",
		agents: {
			scout: {
				file: "scout.md",
				model: "haiku",
				tools: ["Read", "Glob", "Grep", "Bash"],
				capabilities: ["explore", "research"],
				canSpawn: false,
				constraints: ["read-only"],
			},
			builder: {
				file: "builder.md",
				model: "sonnet",
				tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
				capabilities: ["implement", "refactor", "fix"],
				canSpawn: false,
				constraints: [],
			},
			reviewer: {
				file: "reviewer.md",
				model: "sonnet",
				tools: ["Read", "Glob", "Grep", "Bash"],
				capabilities: ["review", "validate"],
				canSpawn: false,
				constraints: ["read-only"],
			},
			lead: {
				file: "lead.md",
				model: "opus",
				tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
				capabilities: ["coordinate", "implement", "review"],
				canSpawn: true,
				constraints: [],
			},
			merger: {
				file: "merger.md",
				model: "sonnet",
				tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
				capabilities: ["merge", "resolve-conflicts"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: {},
	};
}

/**
 * Build the hooks.json content. Reads from template if available,
 * otherwise generates a default.
 */
async function buildHooksJson(overstoryRoot: string): Promise<string> {
	// Try to read from template
	const templatePath = join(overstoryRoot, "templates", "hooks.json.tmpl");
	const templateFile = Bun.file(templatePath);
	if (await templateFile.exists()) {
		return await templateFile.text();
	}

	// Generate default hooks config — all hook types require {matcher, hooks} wrapper
	const hooks = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory prime",
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory mail check --inject",
						},
					],
				},
			],
			PreToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory log tool-start",
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory log tool-end",
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory log session-end",
						},
					],
				},
			],
			PreCompact: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "overstory prime --compact",
						},
					],
				},
			],
		},
	};

	return `${JSON.stringify(hooks, null, "\t")}\n`;
}

/**
 * Gitignore entries that overstory needs.
 */
const GITIGNORE_ENTRIES = [
	"",
	"# Overstory",
	".overstory/worktrees/",
	".overstory/logs/",
	".overstory/mail.db",
	".overstory/mail.db-wal",
	".overstory/mail.db-shm",
	".overstory/metrics.db",
	".overstory/metrics.db-wal",
	".overstory/metrics.db-shm",
];

/**
 * Update .gitignore to include overstory entries.
 * Appends if the file exists, creates if not.
 * Skips entries that already exist.
 */
async function updateGitignore(projectRoot: string): Promise<boolean> {
	const gitignorePath = join(projectRoot, ".gitignore");
	const file = Bun.file(gitignorePath);

	let existingContent = "";
	if (await file.exists()) {
		existingContent = await file.text();
	}

	// Check if overstory section already exists
	if (existingContent.includes("# Overstory")) {
		return false;
	}

	// Ensure existing content ends with a newline before appending
	const prefix = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";

	const newContent = `${existingContent}${prefix}${GITIGNORE_ENTRIES.join("\n")}\n`;
	await Bun.write(gitignorePath, newContent);

	return true;
}

/**
 * Resolve the overstory tool root directory (where templates/ lives).
 *
 * Uses import.meta.dir to find the overstory package root,
 * since this file is at src/commands/init.ts.
 */
function getOverstoryRoot(): string {
	// import.meta.dir is the directory of this file: src/commands/
	// Go up two levels to get the overstory package root
	return join(import.meta.dir, "..", "..");
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	process.stdout.write(`  \u2713 Created ${relativePath}\n`);
}

/**
 * Print a skip status line.
 */
function printSkipped(relativePath: string, reason: string): void {
	process.stdout.write(`  - Skipped ${relativePath} (${reason})\n`);
}

/**
 * Entry point for `overstory init [--force]`.
 *
 * Scaffolds the .overstory/ directory structure in the current working directory.
 *
 * @param args - CLI arguments after "init" subcommand
 */
export async function initCommand(args: string[]): Promise<void> {
	const force = args.includes("--force");
	const projectRoot = process.cwd();
	const overstoryPath = join(projectRoot, OVERSTORY_DIR);

	// 1. Check if .overstory/ already exists
	const existingDir = Bun.file(join(overstoryPath, "config.yaml"));
	if (await existingDir.exists()) {
		if (!force) {
			process.stdout.write(
				"Warning: .overstory/ already initialized in this project.\n" +
					"Use --force to reinitialize.\n",
			);
			return;
		}
		process.stdout.write("Reinitializing .overstory/ (--force)\n\n");
	}

	// 2. Detect project info
	const projectName = await detectProjectName(projectRoot);
	const canonicalBranch = await detectCanonicalBranch(projectRoot);

	process.stdout.write(`Initializing overstory for "${projectName}"...\n\n`);

	// 3. Create directory structure
	const dirs = [
		OVERSTORY_DIR,
		join(OVERSTORY_DIR, "agents"),
		join(OVERSTORY_DIR, "worktrees"),
		join(OVERSTORY_DIR, "specs"),
		join(OVERSTORY_DIR, "logs"),
	];

	for (const dir of dirs) {
		await mkdir(join(projectRoot, dir), { recursive: true });
		printCreated(`${dir}/`);
	}

	// 4. Write config.yaml
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = projectName;
	config.project.root = projectRoot;
	config.project.canonicalBranch = canonicalBranch;

	const configYaml = serializeConfigToYaml(config);
	const configPath = join(overstoryPath, "config.yaml");
	await Bun.write(configPath, configYaml);
	printCreated(`${OVERSTORY_DIR}/config.yaml`);

	// 5. Write agent-manifest.json
	const manifest = buildAgentManifest();
	const manifestPath = join(overstoryPath, "agent-manifest.json");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	printCreated(`${OVERSTORY_DIR}/agent-manifest.json`);

	// 6. Write hooks.json
	const overstoryRoot = getOverstoryRoot();
	const hooksContent = await buildHooksJson(overstoryRoot);
	const hooksPath = join(overstoryPath, "hooks.json");
	await Bun.write(hooksPath, hooksContent);
	printCreated(`${OVERSTORY_DIR}/hooks.json`);

	// 7. Update .gitignore
	const gitignoreUpdated = await updateGitignore(projectRoot);
	if (gitignoreUpdated) {
		printCreated(".gitignore (updated)");
	} else {
		printSkipped(".gitignore", "overstory entries already present");
	}

	process.stdout.write("\nDone. Run `overstory status` to see the current state.\n");
}

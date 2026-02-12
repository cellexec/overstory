/**
 * Mulch CLI client.
 *
 * Wraps the `mulch` command-line tool for structured expertise operations.
 * Uses Bun.spawn — zero runtime dependencies.
 */

import { AgentError } from "../errors.ts";

export interface MulchStatus {
	domains: Array<{ name: string; recordCount: number; lastUpdated: string }>;
}

export interface MulchClient {
	/** Generate a priming prompt, optionally scoped to specific domains. */
	prime(domains?: string[], format?: "markdown" | "xml" | "json"): Promise<string>;

	/** Show domain statistics. */
	status(): Promise<MulchStatus>;

	/** Record an expertise entry for a domain. */
	record(
		domain: string,
		options: {
			type: string;
			name?: string;
			description?: string;
			title?: string;
			rationale?: string;
			tags?: string[];
			classification?: string;
		},
	): Promise<void>;

	/** Query expertise records, optionally scoped to a domain. */
	query(domain?: string): Promise<string>;

	/** Search records across all domains. */
	search(query: string): Promise<string>;
}

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Create a MulchClient bound to the given working directory.
 *
 * @param cwd - Working directory where mulch commands should run
 * @returns A MulchClient instance wrapping the mulch CLI
 */
export function createMulchClient(cwd: string): MulchClient {
	async function runMulch(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["mulch", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`mulch ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async prime(domains, format) {
			const args = ["prime"];
			if (domains && domains.length > 0) {
				args.push(...domains);
			}
			if (format) {
				args.push("--format", format);
			}
			const { stdout } = await runMulch(args, "prime");
			return stdout;
		},

		async status() {
			const { stdout } = await runMulch(["status", "--json"], "status");
			const trimmed = stdout.trim();
			if (trimmed === "") {
				return { domains: [] };
			}
			try {
				return JSON.parse(trimmed) as MulchStatus;
			} catch {
				throw new AgentError(
					`Failed to parse JSON output from mulch status: ${trimmed.slice(0, 200)}`,
				);
			}
		},

		async record(domain, options) {
			const args = ["record", domain, "--type", options.type];
			if (options.name) {
				args.push("--name", options.name);
			}
			if (options.description) {
				args.push("--description", options.description);
			}
			if (options.title) {
				args.push("--title", options.title);
			}
			if (options.rationale) {
				args.push("--rationale", options.rationale);
			}
			if (options.tags && options.tags.length > 0) {
				args.push("--tags", options.tags.join(","));
			}
			if (options.classification) {
				args.push("--classification", options.classification);
			}
			await runMulch(args, `record ${domain}`);
		},

		async query(domain) {
			const args = ["query"];
			if (domain) {
				args.push(domain);
			}
			const { stdout } = await runMulch(args, "query");
			return stdout;
		},

		async search(query) {
			const { stdout } = await runMulch(["search", query], "search");
			return stdout;
		},
	};
}

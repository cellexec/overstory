#!/usr/bin/env bun
/**
 * Overstory CLI — main entry point and command router.
 *
 * Routes subcommands to their respective handlers in src/commands/.
 * Usage: overstory <command> [args...]
 */

import { initCommand } from "./commands/init.ts";
import { logCommand } from "./commands/log.ts";
import { mailCommand } from "./commands/mail.ts";
import { mergeCommand } from "./commands/merge.ts";
import { metricsCommand } from "./commands/metrics.ts";
import { primeCommand } from "./commands/prime.ts";
import { slingCommand } from "./commands/sling.ts";
import { statusCommand } from "./commands/status.ts";
import { watchCommand } from "./commands/watch.ts";
import { worktreeCommand } from "./commands/worktree.ts";
import { OverstoryError } from "./errors.ts";

const VERSION = "0.1.0";

const HELP = `overstory v${VERSION} — Multi-agent orchestration for Claude Code

Usage: overstory <command> [args...]

Commands:
  init                    Initialize .overstory/ in current project
  sling <task-id>         Spawn a worker agent
  prime                   Load context for orchestrator/agent
  status                  Show all active agents and project state
  mail <sub>              Mail system (send/check/list/read/reply)
  merge                   Merge agent branches into canonical
  worktree <sub>          Manage worktrees (list/clean)
  log <event>             Log a hook event
  watch                   Start watchdog daemon
  metrics                 Show session metrics

Options:
  --help, -h              Show this help
  --version, -v           Show version

Run 'overstory <command> --help' for command-specific help.`;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	const commandArgs = args.slice(1);

	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(`${HELP}\n`);
		return;
	}

	if (command === "--version" || command === "-v") {
		process.stdout.write(`overstory v${VERSION}\n`);
		return;
	}

	switch (command) {
		case "init":
			await initCommand(commandArgs);
			break;
		case "sling":
			await slingCommand(commandArgs);
			break;
		case "prime":
			await primeCommand(commandArgs);
			break;
		case "status":
			await statusCommand(commandArgs);
			break;
		case "mail":
			await mailCommand(commandArgs);
			break;
		case "merge":
			await mergeCommand(commandArgs);
			break;
		case "worktree":
			await worktreeCommand(commandArgs);
			break;
		case "log":
			await logCommand(commandArgs);
			break;
		case "watch":
			await watchCommand(commandArgs);
			break;
		case "metrics":
			await metricsCommand(commandArgs);
			break;
		default:
			process.stderr.write(`Unknown command: ${command}\n`);
			process.stderr.write(`Run 'overstory --help' for usage.\n`);
			process.exit(1);
	}
}

main().catch((err: unknown) => {
	if (err instanceof OverstoryError) {
		process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
		process.exit(1);
	}
	if (err instanceof Error) {
		process.stderr.write(`Error: ${err.message}\n`);
		if (process.argv.includes("--verbose")) {
			process.stderr.write(`${err.stack}\n`);
		}
		process.exit(1);
	}
	process.stderr.write(`Unknown error: ${String(err)}\n`);
	process.exit(1);
});

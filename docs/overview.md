# Overstory: How It Works

Overstory turns a single Claude Code session into a multi-agent swarm. No daemon, no server -- your Claude Code session **is** the orchestrator. It coordinates worker agents through git worktrees, tmux sessions, and a SQLite mail system.

## Core Idea

```
You (Claude Code)
  |-- overstory sling --> Lead agent (can spawn sub-workers)
  |                         |-- Builder (writes code)
  |                         |-- Scout (read-only exploration)
  |                         |-- Reviewer (validates work)
  |-- overstory mail  --> Async messaging between agents
  |-- overstory merge --> Merge agent branches back (sequentially, as each is ready)
```

Each agent runs as an independent Claude Code process in its own git worktree and tmux session. Agents communicate through a shared SQLite mailbox, not stdio or sockets.

## Agent Lifecycle

### 1. Spawn (`overstory sling`)

When you run `overstory sling <task-id> --capability builder --name impl-auth`:

1. **Validates hierarchy** -- builders/scouts need a `--parent`, leads don't. Max depth is enforced (default 2).
2. **Creates a git worktree** -- `git worktree add` makes an isolated copy of the repo on a new branch `overstory/{name}/{taskId}`.
3. **Generates a CLAUDE.md overlay** -- Two-layer instructions: a base definition (the HOW, from `agents/builder.md`) and a per-task overlay (the WHAT -- task ID, file scope, spec path). Written to the worktree's `.claude/CLAUDE.md`.
4. **Deploys safety hooks** -- PreToolUse hooks prevent agents from writing outside their worktree, pushing to main, or using Claude Code's native team tools.
5. **Starts a tmux session** -- `tmux new-session` launches `claude --model sonnet --dangerously-skip-permissions` in the worktree directory.
6. **Sends a startup beacon** -- After a brief pause, `tmux send-keys` delivers the task context so the agent begins working.

### 2. Work

Agents work autonomously within their worktree. They read their overlay CLAUDE.md for instructions, load project expertise via `mulch prime`, and follow their capability-specific workflow (build, explore, review). All changes stay on their isolated branch.

### 3. Communicate (`overstory mail`)

Agents talk through a SQLite database (`.overstory/mail.db`, WAL mode for concurrent access). A `UserPromptSubmit` hook runs `overstory mail check --inject` before each agent prompt, prepending unread messages to the agent's context.

Message types include semantic (`status`, `question`, `result`, `error`) and protocol (`worker_done`, `merge_ready`, `merged`, `escalation`). Protocol messages carry typed JSON payloads -- e.g., `worker_done` includes the branch name, exit code, and list of modified files.

### 4. Merge (`overstory merge`)

When an agent's work is ready, the merge system uses four escalating tiers:

| Tier | Strategy | How |
|------|----------|-----|
| 1 | Clean merge | `git merge` -- if no conflicts, done |
| 2 | Auto-resolve | Parse conflict markers, keep incoming (agent's) changes |
| 3 | AI-resolve | Prompt Claude to resolve each conflicted file |
| 4 | Reimagine | Abort merge, reimplement agent changes onto canonical from scratch |

Past conflict outcomes are recorded in mulch and fed back into tier 3/4 prompts for smarter future resolutions.

## Agent Hierarchy

```
Coordinator (depth 0) -- top-level orchestrator
  --> Lead (depth 1) -- plans work, spawns specialists
        --> Builder (depth 2) -- writes code, runs tests
        --> Scout (depth 2) -- read-only exploration
        --> Reviewer (depth 2) -- validates, runs quality gates
        --> Merger (depth 2) -- branch merge specialist
```

Only coordinators, supervisors, and leads can spawn sub-agents (`canSpawn: true`). Builders, scouts, and reviewers are leaf nodes. The max depth is configurable (default 2) to prevent runaway spawning.

## Safety Model

Every agent worktree gets hook guards deployed to `.claude/settings.local.json`:

- **Path boundary** -- Write/Edit tools are blocked outside the agent's worktree
- **Branch protection** -- No pushing to main/master, no `git reset --hard`
- **Tool restrictions** -- Non-implementation agents (scout, reviewer) can't use Write/Edit at all. Builders get write access only within their worktree.
- **Native team tool blocks** -- Claude Code's built-in Task/Team/SendMessage tools are blocked. Agents must use `overstory sling` and `overstory mail`.

## Watchdog (Health Monitoring)

A background daemon (`overstory watch`) polls agent health on an interval:

- **Level 0**: Log a warning
- **Level 1**: Send a tmux nudge to the stalled agent
- **Level 2**: AI triage -- read the agent's recent logs, classify as retry/terminate/extend
- **Level 3**: Kill the tmux session and its entire process tree

Escalation is time-based: the longer an agent is stalled, the more aggressive the response.

## Key Design Decisions

- **Zero runtime dependencies.** Only Bun built-ins (`bun:sqlite`, `Bun.spawn`, `Bun.file`). External tools (git, tmux, bd, mulch) are subprocesses.
- **SQLite for everything.** Mail, sessions, events, metrics, merge queue -- all WAL-mode SQLite for safe concurrent multi-process access.
- **Git worktrees for isolation.** Each agent gets a real filesystem and branch. No virtual environments, no containers.
- **Hooks for injection.** Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`) are the glue that connects overstory to each agent session without modifying Claude Code itself.

# Overstory

Project-agnostic swarm system for Claude Code agent orchestration.

## Issue Tracking (beads)

This project uses **bd** (beads) for issue tracking.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Expertise (mulch)

This project uses **mulch** for structured expertise.

```bash
mulch prime [domain]  # Output a priming prompt (optionally scoped to one domain)
mulch status          # Show domain statistics
mulch add <domain>    # Add a new domain
mulch record <domain> # Record an expertise record
mulch query [domain]  # Query expertise records
mulch search [query]  # Search records across domains
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

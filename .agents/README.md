# .agents/ — Shared Agent Knowledge Layer

Agent-agnostic workspace. Any AI coding tool (OpenCode, Claude Code, Kiro, etc.) reads and writes here. Tool-specific runtime state stays in its own directory (`.opencode/`, `.claude/`).

## Structure

| Directory | Purpose |
|-----------|---------|
| `checkpoints/` | Progress snapshots at natural stopping points |
| `learnings/` | Post-mortems and approach notes (after non-trivial problems) |
| `notes/` | Ad-hoc notes, review findings, anything worth keeping |
| `changes/` | Granular change records per session |
| `steering/` | Conventions and directives that guide agent behavior |

## Guide for Agents

### Where to write what

| You want to record... | Write to |
|----------------------|----------|
| A discovery (how something works, gotchas, reusable pattern) | `learnings/` |
| Progress at a stopping point | `checkpoints/` |
| What you changed this session | `changes/` |
| Project conventions that agents should follow | `steering/` |
| Anything else worth keeping | `notes/` |

### Naming conventions

- Learnings: `YYYY-MM-DD-<slug>.md`
- Checkpoints: `YYYY-MM-DD-<project>.md`
- Changes: `YYYY-MM-DD-NN-<description>.md`

### Session history

Each tool maintains its own session history in its own directory (`.opencode/history.md`, `.claude/` memory). Do NOT write session logs here. The shared layer is for knowledge artifacts worth finding later, not ephemeral session state.

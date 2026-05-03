# Qodo Rules Draft

Suggested Qodo rules for `idea-maze-claw`, derived from the repository philosophy and contribution constraints in [README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [REQUIREMENTS.md](./REQUIREMENTS.md), and [AGENTS.md](../AGENTS.md).

Current repository scope from `origin`:

```text
/bknstn/idea-maze-claw/
```

Path-specific scope for the product discovery pipeline:

```text
/bknstn/idea-maze-claw/groups/idea-maze/
```

These entries use the fields Qodo expects during retrieval: `name`, `severity`, `category`, `scope`, and `description`.

## Repo-Level Rules

```yaml
- name: No Hardcoded Credentials
  severity: error
  category: Security
  scope: /bknstn/idea-maze-claw/
  description: Never commit API keys, OAuth tokens, session cookies, passwords, or other secrets. Credentials must stay on the host side and flow through OneCLI Agent Vault or equivalent proxy-based injection; agent containers must not receive raw secrets through files, prompts, or mounts.

- name: Preserve Isolation Boundaries
  severity: error
  category: Security
  scope: /bknstn/idea-maze-claw/
  description: Do not weaken per-group filesystem isolation, container execution boundaries, or scoped mounts. Changes must not expose one group's memory, database, or workspace to another group unless the user explicitly requests it and the security tradeoff is documented.

- name: Skills Not Core Features
  severity: error
  category: Architecture
  scope: /bknstn/idea-maze-claw/
  description: New channels, integrations, and optional capabilities belong in skills or skill branches. Core source changes should be limited to bug fixes, security fixes, simplifications, or plumbing needed to support existing skill workflows.

- name: Prefer Code Over Config Sprawl
  severity: warning
  category: Architecture
  scope: /bknstn/idea-maze-claw/
  description: Prefer direct code changes over new environment variables, config files, or feature flags. Introduce new configuration only when there is a clear operational need and keep defaults minimal.

- name: Preserve Self-Registration Architecture
  severity: warning
  category: Architecture
  scope: /bknstn/idea-maze-claw/
  description: Channels should self-register at startup through the registry and router flow. Avoid bespoke startup paths, one-off dispatch branches, or special-case routing that bypasses the existing orchestration pattern.

- name: Prefer Non-Interactive Safe Automation
  severity: warning
  category: Operations
  scope: /bknstn/idea-maze-claw/
  description: Automation, scripts, and agent workflows should use non-interactive commands and must avoid destructive git operations by default. Do not require TTY-driven confirmation or introduce reset-style workflows into routine operations.

- name: Verify Behavior-Changing Edits
  severity: warning
  category: Testing
  scope: /bknstn/idea-maze-claw/
  description: Behavior-changing changes should include targeted verification. Run npm run build, add or update focused tests when practical, and explicitly note any testing gap when a change cannot be covered reasonably.

- name: Keep the Base System Small
  severity: recommendation
  category: Maintainability
  scope: /bknstn/idea-maze-claw/
  description: Favor the smallest implementation that preserves the single-process design and keeps the codebase easy to understand. Avoid new services, daemons, or dependencies unless they materially simplify the system.
```

## Path-Level Rules For `groups/idea-maze/`

```yaml
- name: Preserve Automated Artifact Publication
  severity: error
  category: Pipeline
  scope: /bknstn/idea-maze-claw/groups/idea-maze/
  description: The Idea Maze pipeline is fully automated. Score-bucket 9-10 opportunities should publish artifacts automatically, lower-score opportunities should be skipped or ignored, and user-facing pipeline output must not ask for manual research decisions.

- name: Treat Raw Harvest Data As Immutable
  severity: warning
  category: Data
  scope: /bknstn/idea-maze-claw/groups/idea-maze/
  description: Raw source snapshots are immutable inputs. Downstream stages should derive new records, tables, or runs instead of mutating harvested evidence in place, except for explicit retention or cleanup jobs.
```

## Recommended First Pass In Qodo

If you want to start minimal, create these first:

1. `No Hardcoded Credentials`
2. `Preserve Isolation Boundaries`
3. `Skills Not Core Features`
4. `Preserve Automated Artifact Publication`

Those four capture the highest-risk constraints in this repo. The rest mainly tighten architecture discipline and review quality.

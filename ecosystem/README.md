# Ecosystem

Machine-local harness configuration that generators and local plugins consume. The
tree is operator-owned, not product code: nothing in `packages/`, `apps/`, or the
official bundle catalog imports from it.

## Layout

| Path | Purpose |
|------|---------|
| [`profiles/`](profiles/ultracode/package.json) | Profile templates. `ultracode` is the canonical one: every profile the launchers expose is regenerated from it. |
| [`plugins/`](plugins/) | Local plugins referenced by `file:` from the profiles. |
| [`scripts/`](scripts/) | Operator entry points: profile rebuild, Russian-locale generation, swarm reclaim, duty tables. |

## Profiles

`profiles/ultracode` boots the DeepSeek Harness TUI plus the full third-party
plugin stack (swarm orchestration, quality gates, worktree isolation, UltraCode
working mode). The live copy is installed at `$DSH_HOME/profiles/ultracode`;
`scripts/dsh-profiles-sync` regenerates every profile from this template, so edit
the template rather than a generated profile.

| Profile | Surface |
|---------|---------|
| `web` | Browser dashboard plus an always-on systemd service. |
| `ultracode` | TUI with the UltraCode preset. |
| `dsh-tui` | Plain TUI surface, same plugin stack. |
| `desktop` | The desktop client's own profile (Electron carrier boots it). |
| `decay` | Web surface where `dsh-context-decay` owns context reduction. |
| `headless` | One-shot `dsh headless "task"` surface. |

Exactly one context reducer runs per profile. `dsh-context-decay` (model-driven)
is mounted everywhere, so the official automatic compaction — host
`compaction-basic.auto`, the preset compaction group, and
`@ohmejj/dsh-auto-compact` — is switched off. Manual `/compact` stays available as
an emergency fallback.

## Plugins

Four local plugins, each consumed through a `file:` dependency:

| Plugin | Purpose |
|--------|---------|
| [`dsh-local-ru`](plugins/dsh-local-ru/) | Russian-locale duty tables: baseline, context decay, loop guard, protect-tests, session retry, stall guard, swarm, auto-review. |
| [`dsh-subagent-compat`](plugins/dsh-subagent-compat/) | Subagent compatibility shim. |
| [`dsh-swarm-autonomy-guard`](plugins/dsh-swarm-autonomy-guard/) | Swarm autonomy boundary. |
| [`dsh-swarm-worktree`](plugins/dsh-swarm-worktree/) | Worktree isolation for swarm workers. |

Each plugin's `lib/` holds hand-written source. The repository-wide `lib/`
gitignore rule is negated for `ecosystem/plugins/*/lib/**` so these files are
tracked.

## Scripts

`scripts/dsh-profiles-sync` is the entry point for profile management. The rest
are per-plugin operators invoked from profile patches: Russian-locale build and
patch, swarm store reclaim, frugality environment, host seam, duty tables.

## Operating this tree

Rebuild every profile from the template:

```sh
ecosystem/scripts/dsh-profiles-sync
```

The script is idempotent. It rewrites each profile manifest, patch layer, and
pnpm settings, then reinstalls dependencies.
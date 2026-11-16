# Ecosystem

Machine-local harness configuration that generators and local plugins consume. The
tree is operator-owned, not product code: nothing in `packages/`, `apps/`, or the
official bundle catalog imports from `ecosystem/`.

## Layout

| Path | Purpose |
|------|---------|
| [`profiles/`](profiles/ultracode/package.json) | Profile templates. `ultracode` is the canonical one: every profile the launchers expose is regenerated from it. |
| [`plugins/`](plugins/) | Local plugins referenced by `file:` from the profiles. |
| [`patches/`](profiles/ultracode/patches/) | Ports of third-party plugins to this runtime. |
| [`scripts/`](scripts/) | Operator entry points: profile rebuild, plugin ports, checks, Russian-locale generation, swarm reclaim, duty tables. |

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
| `desktop` | The desktop client's own profile (the Electron carrier boots it; the CLI refuses that profile by design). |
| `decay` | Web surface where `dsh-context-decay` owns context reduction. |
| `headless` | One-shot `dsh headless "task"` surface. |

Exactly one context reducer runs per profile. `dsh-context-decay` (model-driven)
is mounted everywhere, so the official automatic compaction — host
`compaction-basic.auto` and the preset compaction group — is switched off. Manual
`/compact` stays available as an emergency fallback.

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

## Plugin ports

Third-party plugins that still call APIs this runtime removed are patched per
profile. `scripts/dsh-profile-patches` regenerates each patch from the pristine
plugin source, so the hunk headers always match the installed file:

| Plugin | Port |
|--------|------|
| `dsh-session-retry` | `ctx.agents.roots()` → `ctx.agents.list()`. |
| `dsh-task-reliability` | `ctx.root` → `ctx[Context.root]`. |
| `@doiiarx/dsh-todo-continuation` | Pinned to the upstream commit that reads its settings from the plugin's own configuration entry. |

A patch file quotes the upstream source verbatim, including its tab indentation,
so the staged-whitespace check skips `ecosystem/profiles/*/patches/*.patch`.

## Scripts

| Script | Purpose |
|--------|---------|
| `dsh-profiles-sync` | Rebuild every profile from the template. Idempotent. |
| `dsh-profile-patches` | Regenerate the third-party plugin ports. |
| `dsh-ecosystem-check` | Boot every profile and assert the whole plugin stack is present and the runtime resolves from this checkout. |
| `dsh-local-ru-check` | Fetch the served client bundles and assert every Russian dictionary key reaches the browser. |
| `dsh-swarm-worktree-check` | Drive the worktree cycle on a temporary repository: a worktree branch, a worker commit, and the merge back into main. |
| `dsh-swarm-check` | Drive one complex task through the swarm and report the dispatch, the worktrees, and the plugin failures. |
| `dsh-local-ru-build` | Rebuild the Russian-locale client bundle from the tables. |
| `dsh-single-reducer` | Keep exactly one context reducer active per profile. |
| `dsh-swarm-autonomy` | Let the swarm dispatch itself for a complex task. |
| `dsh-duty-table` | Pin every swarm storage to a working model. |
| `dsh-swarm-reclaim` | Release a stale swarm-store ownership marker. |

## Operating this tree

Rebuild every profile from the template:

```sh
ecosystem/scripts/dsh-profiles-sync
```

Then check the result:

```sh
ecosystem/scripts/dsh-ecosystem-check
ecosystem/scripts/dsh-local-ru-check
ecosystem/scripts/dsh-swarm-worktree-check
```

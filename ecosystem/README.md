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
| [`scripts/`](scripts/) | Operator entry points: profile rebuild, plugin ports, boot/plugin/swarm/locale checks, Russian-locale generation, swarm reclaim, duty tables. |

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

### How a profile is assembled

`dsh-profiles-sync` writes two things a plain `file:` reference cannot express:

- **Runtime links.** Every profile depends directly on the fork's own runtime
  packages (`packages/*/*`) and on the three vendored Cordis foundations
  (`@deepseek-ai/cordis`, `cosmokit`, `schemastery`). `pnpm.overrides` applies to
  direct dependencies only, so the vendored foundations are listed as direct
  ones; otherwise a plugin that imports `schemastery` fails to resolve it, and the
  npm copy of a runtime package shadows the fork's build and crashes the host.
- **TUI patches.** Only the TUI profiles carry the `@deepseek-harness-tui` patch:
  pnpm refuses a patch for a package the profile does not install, so the patch
  list is built per profile name.

## Plugins

Four local plugins, each consumed through a `file:` dependency:

| Plugin | Purpose |
|--------|---------|
| [`dsh-local-ru`](plugins/dsh-local-ru/) | Russian-locale duty tables: baseline, context decay, loop guard, protect-tests, session retry, stall guard, swarm, auto-review. |
| [`dsh-subagent-compat`](plugins/dsh-subagent-compat/) | Subagent compatibility shim: maps the legacy `start(parent, prompt, cwd)` call onto this runtime's activation spec. |
| [`dsh-swarm-autonomy-guard`](plugins/dsh-swarm-autonomy-guard/) | Swarm autonomy boundary. |
| [`dsh-swarm-worktree`](plugins/dsh-swarm-worktree/) | Worktree isolation for swarm workers: one worktree per task agent, the merge back into the target branch on acceptance, and the release afterwards. |

`dsh-swarm-worktree` releases a worktree only when its work is accounted for: a
worker that committed is merged into the target branch and its directory and
branch are removed, a worker that committed nothing fails its own task and is
released, and a run that ends with work never accepted **keeps** the worktree and
reports it, because the branch may hold finished, unmerged work.

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
| `dsh-host-seam` | Add the `modelMessageDecoration` seam to the installed runtime. |
| `dsh-ecosystem-check` | Boot every profile and assert the whole plugin stack is present and the runtime resolves from this checkout. |
| `dsh-plugin-activation-check` | Boot every profile and assert each plugin entry reports that it activated (no silent skip). |
| `dsh-plugin-behaviour-check` | Boot every profile and assert each plugin contributes what it is there for (tool groups, commands, guards, presets). |
| `dsh-plugin-unit-check` | Import every local plugin's own `lib/` and exercise its exported units. |
| `dsh-plugin-load-check` | Import every third-party plugin through the profile's resolution and report its export. |
| `dsh-provider-check` | Ask one model through the harness's own provider chain and report the status, latency, and first bytes. Network-dependent: a refusal is reported, not retried. |
| `dsh-swarm-worktree-check` | Drive the worktree cycle on a temporary repository: a worktree branch, a worker commit, the merge back into main, the release, and the keep-on-failure path. |
| `dsh-swarm-spawn-check` | Reproduce one swarm task-agent spawn against the real profile runtime and report the activation spec. |
| `dsh-swarm-check` | Drive one complex task through the swarm and report the dispatch, the worktrees, and the plugin failures. |
| `dsh-swarm-trace` | Locate the exact line that fails a swarm task-agent spawn (diagnostic companion of `dsh-swarm-spawn-check`). |
| `dsh-local-ru-check` | Fetch the served client bundles and assert every Russian dictionary key reaches the browser. |
| `dsh-local-ru-build` | Rebuild the Russian-locale client bundle from the tables. |
| `dsh-local-ru-patch` | Apply the Russian-locale bundle to an installed profile. |
| `dsh-ru-keys` | Collect the English UI keys of the swarm stack plugins. |
| `dsh-ru-translations` | Generate the Russian dictionaries of the swarm stack panels. |
| `dsh-single-reducer` | Keep exactly one context reducer active per profile. |
| `dsh-swarm-autonomy` | Let the swarm dispatch itself for a complex task. |
| `dsh-duty-table` | Pin every swarm storage to a working model. |
| `dsh-swarm-reclaim` | Release a stale swarm-store ownership marker. |
| `dsh-frugality-env` | Export the `DSH_*` frugality variables the launchers and systemd units source. |
| `dsh-web` | Start the web surface from the fork checkout. |

## Operating this tree

Rebuild every profile from the template:

```sh
ecosystem/scripts/dsh-profiles-sync
```

Then check the result. The boot checks prove the stack loads; the plugin checks
prove each plugin activates and contributes; the swarm checks drive the real
dispatch and the worktree cycle; the locale check proves the Russian dictionaries
reach the browser:

```sh
ecosystem/scripts/dsh-ecosystem-check
ecosystem/scripts/dsh-plugin-activation-check
ecosystem/scripts/dsh-plugin-behaviour-check
ecosystem/scripts/dsh-plugin-load-check
ecosystem/scripts/dsh-plugin-unit-check
ecosystem/scripts/dsh-local-ru-check
ecosystem/scripts/dsh-swarm-spawn-check
ecosystem/scripts/dsh-swarm-worktree-check
```

`dsh-swarm-check` and `dsh-provider-check` need a reachable provider: the allowed
model set is fixed (`MiniMax-M3.1-Flash`, `Qwen3.8-Flash-Next`, `step-5-preview`,
`longcat-2.5`, `auto` is never dispatched) and the check retries in a circle until
a provider answers.

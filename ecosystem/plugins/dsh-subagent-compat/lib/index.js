// src/index.ts
/**
 * dsh-subagent-compat
 *
 * Two compatibility shims for DSH 0.2.2-rc.1:
 *
 * 1. Legacy subagent entry point
 *
 *    DSH 0.2.x renamed the subagent entry point:
 *
 *      legacy (0.1.x / dsh-swarm-orchestrator 0.6.x)
 *        const run = await ctx.get('subagents').start('spawn', request)
 *        run.id / run.result / run.dispose()
 *
 *      current (0.2.x)
 *        const receipt = await ctx.get('subagents').startActivation({
 *          provider: 'spawn', label, request, signal, delivery
 *        })
 *        receipt.childId / receipt.result / receipt.dispose()
 *
 *    The swarm orchestrator (0.6.33 / 0.6.34) still calls the legacy form, so
 *    every task agent dies with "subagents.start is not a function" and the run
 *    is marked failed. This plugin restores the legacy method on the service
 *    instance by forwarding it to startActivation(), so the whole stack keeps
 *    working on DSH 0.2.2-rc.1 without patching the orchestrator itself.
 *
 *    Role personas are folded into the child prompt, because the 0.2.x request
 *    contract has no persona field any more (it is only carried by the persisted
 *    subagent descriptor).
 *
 *    The spawning agent, the prompt and the working directory travel as the
 *    spec's own fields: the 0.2.x service checks the parent against the live
 *    agent registry and iterates the prompt, so a spec that keeps them inside
 *    a nested provider request fails with "Cannot read properties of undefined
 *    (reading 'id')" or "prompt is not iterable".
 *
 * 2. Stale swarm event-store ownership markers
 *
 *    dsh-swarm-orchestrator owns its event store with an EXCLUSIVE and NEVER
 *    EXPIRING marker file ("events.jsonl.owner"). The plugin refuses to start
 *    the swarm service while the marker exists and never reclaims it by PID
 *    liveness - a paused owner must not lose ownership to a new writer.
 *
 *    Consequence for an interactive profile: when a TUI session is killed
 *    (SIGKILL, terminal close, crash), the marker survives and EVERY later
 *    session boots without a swarm service at all - no swarm_* tools, no
 *    board, no dispatch. This module performs the operator-side recovery the
 *    plugin demands, BEFORE the swarm plugin applies: the recorded PID is
 *    checked, and only a marker whose owner is provably gone is removed.
 */

import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Prepend a persona paragraph to the first text part of a prompt array. */
function withPersona(prompt, persona) {
    if (!Array.isArray(prompt))
        return prompt;
    const index = prompt.findIndex((part) => part !== null && typeof part === 'object' && part.type === 'text');
    if (index === -1)
        return [{ type: 'text', text: persona }, ...prompt];
    const parts = [...prompt];
    const part = parts[index];
    parts[index] = { ...part, text: `${persona}\n\n${part.text}` };
    return parts;
}

/** Whether the PID is alive and still looks like a dsh process. */
function isLiveDshProcess(pid) {
    let cmdline;
    try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    }
    catch {
        return false;
    }
    return cmdline.includes('dsh');
}

/**
 * Reclaim stale swarm ownership markers under $DSH_HOME/storages.
 *
 * A marker is stale when its recorded PID no longer exists, or when the PID was
 * recycled by a process that is not dsh. A marker owned by a LIVE dsh process
 * is left untouched - that writer still holds the store.
 */
export function reclaimStaleSwarmMarkers(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
    const storageRoot = join(home, 'storages');
    let entries;
    try {
        entries = readdirSync(storageRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const reclaimed = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('swarm'))
            continue;
        const marker = join(storageRoot, entry.name, 'events.jsonl.owner');
        let raw;
        try {
            raw = readFileSync(marker, 'utf8');
        }
        catch {
            continue;
        }
        const match = /"pid"\s*:\s*(\d+)/.exec(raw);
        if (match === null)
            continue;
        const pid = Number(match[1]);
        if (Number.isSafeInteger(pid) && pid > 0 && isLiveDshProcess(pid))
            continue;
        try {
            unlinkSync(marker);
            reclaimed.push(marker);
        }
        catch {
            // Another writer may have released it in the meantime; ignore.
        }
    }
    return reclaimed;
}

// Reclaim at module load: the loader imports every plugin module before it
// activates any of them, so this runs before dsh-swarm-orchestrator tries to
// acquire the event store.
for (const marker of reclaimStaleSwarmMarkers())
    console.log(`[subagent-compat] reclaimed stale swarm ownership marker: ${marker}`);

function apply(ctx) {
    const logger = ctx.logger?.('subagent-compat');
    const note = (message) => {
        if (logger !== undefined && typeof logger.info === 'function')
            logger.info('%s', message);
        else
            console.log(`[subagent-compat] ${message}`);
    };
    // One-shot diagnostic: which runtime services this profile actually has.
    // Plugins that declare `inject = ['x']` are never applied when the service
    // 'x' is absent from the composition, so this list explains silent gates.
    // Reported on the first agent creation: by then the whole composition has
    // booted and every service that was going to exist does exist.
    {
        const wanted = ['settings', 'shell', 'goals', 'tools', 'systemPrompt',
            'webServer', 'agentPresets', 'agentPresetRegistry', 'subagents', 'swarm'];
        let reported = false;
        ctx.on('agent/created', () => {
            if (reported)
                return;
            reported = true;
            const present = wanted.filter(name => ctx.get(name) !== undefined);
            const missing = wanted.filter(name => ctx.get(name) === undefined);
            console.log(`[subagent-compat] services present: [${present.join(', ')}]`
                + (missing.length > 0 ? ` | MISSING: [${missing.join(', ')}]` : ''));
        });
    }
    const patch = (subagents) => {
        if (subagents === undefined || subagents === null)
            return false;
        if (typeof subagents.start === 'function')
            return true;
        if (typeof subagents.startActivation !== 'function')
            return false;
        subagents.start = async (providerName, request) => {
            const { label, prompt, persona, signal, ...rest } = request ?? {};
            const composedPrompt = typeof persona === 'string' && persona.length > 0
                ? withPersona(prompt, persona)
                : prompt;
            // `startActivation` reads `parent`, `prompt` and `cwd` from the spec
            // itself, not from a nested provider request: a spec without them
            // fails the live-parent check ("Cannot read properties of undefined
            // (reading 'id')") or the prompt check ("prompt is not iterable").
            const { parent, cwd, ...providerRequest } = rest;
            const receipt = await subagents.startActivation({
                provider: providerName,
                ...(label === undefined ? {} : { label }),
                ...(parent === undefined ? {} : { parent }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(composedPrompt === undefined ? {} : { prompt: composedPrompt }),
                ...(signal === undefined ? {} : { signal }),
                delivery: 'parent',
                ...(Object.keys(providerRequest).length > 0 ? { request: providerRequest } : {}),
            });
            return {
                id: receipt.childId,
                result: receipt.result,
                dispose: receipt.dispose,
            };
        };
        note('legacy subagents.start() restored on top of startActivation()');
        return true;
    };
    if (patch(ctx.get('subagents')))
        return;
    // The subagents service may not be mounted yet: wait for it instead of
    // giving up, otherwise the swarm would keep failing to spawn task agents.
    ctx.inject(['subagents'], (subagentsCtx) => {
        patch(subagentsCtx.get('subagents'));
    });
    // The swarm plugin registers its tools on the tools service visible from
    // ITS OWN scope. When that lookup fails, the swarm has no tools at all -
    // the repair below registers them on the tools service the agent sees.
    ctx.inject(['swarm'], (swarmCtx) => {
        const service = swarmCtx.get('swarm');
        const own = service?.ctx?.get?.('tools');
        if (own === undefined)
            repairSwarmTools(ctx, service);
    });
}

/**
 * Register the swarm tools into the tools service the AGENT sees.
 *
 * The TUI composes every agent from a preset realm with its own tools
 * service, so a tool registered on the host layer never reaches the agent.
 * The swarm plugin registers its tools on the tools service of its own scope;
 * when that scope has none, the tools are silently lost. Here the swarm
 * tool definitions are registered on the agent's own tools service instead.
 */
function repairSwarmTools(ctx, swarmService) {
    let register;
    try {
        register = requireSwarmToolRegistrar();
    }
    catch (error) {
        console.log('[subagent-compat] swarm tool repair unavailable:', String(error));
        return;
    }
    const mounted = new WeakSet();
    ctx.on('agent/created', ({ agent }) => {
        if (agent === undefined || mounted.has(agent))
            return;
        mounted.add(agent);
        const tools = agent.ctx?.get?.('tools');
        if (tools === undefined)
            return;
        const dispose = register({ get: () => tools }, swarmService);
        ctx.effect(() => () => {
            if (typeof dispose === 'function')
                dispose();
        });
    });
}

/** Resolve the swarm plugin's registerSwarmTools() without a deep import. */
function requireSwarmToolRegistrar() {
    const require = process.getBuiltinModule('node:module').createRequire(import.meta.url);
    const manifest = require.resolve('dsh-swarm-orchestrator/package.json');
    const dir = manifest.slice(0, manifest.lastIndexOf('/'));
    return require(`${dir}/lib/tools/index.js`).registerSwarmTools;
}

export const name = 'subagent-compat';
export { apply };

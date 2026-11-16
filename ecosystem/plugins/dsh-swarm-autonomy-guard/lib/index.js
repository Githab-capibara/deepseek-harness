/**
 * dsh-swarm-autonomy-guard: a complex task must be worked by a swarm.
 *
 * The stack already ships the swarm (dsh-swarm-orchestrator) and the UltraCode
 * persona asks the agent to fan out, but the agent still often starts editing
 * files one by one on its own. This guard runs on `tools/pre-execute` and
 * watches the files a root session mutates in one turn:
 *
 *   - the FIRST file is always allowed: a single-file task is ordinary work
 *     and stays in the UltraCode preset;
 *   - the SECOND distinct file means the task really spans several parts, so
 *     the call is blocked and the agent is told to dispatch a swarm of agents
 *     (one `swarm_dispatch` run with a task DAG) and collect it with
 *     `swarm_wait`;
 *   - once the session has dispatched a swarm (or delegated to a subagent),
 *     the guard never interferes again.
 *
 * The guard is deliberately a nudge, not a lock: after one steering per turn
 * the agent may continue on its own, so a model that refuses to fan out can
 * still finish the task instead of deadlocking.
 *
 * @module dsh-swarm-autonomy-guard
 */
import { isAbsolute, resolve } from 'node:path';

export const name = 'swarm-autonomy-guard';

/** Tools that mean "work is being delegated to agents". */
export const FANOUT_TOOLS = new Set([
    'swarm_dispatch',
    'delegate',
    'subagent',
    'subagent_fork',
    'subagent_start',
]);

/** Tools that mutate a file. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** Tools that run shell commands: a command may mutate files itself. */
const SHELL_TOOLS = new Set(['bash', 'sh', 'shell', 'run_command', 'exec']);

/**
 * True when a shell command writes, moves or deletes files.
 *
 * The heuristics are deliberately broad: a rename hides a file from the guard
 * just as well as a write does, and an agent that rewrites a file with
 * `sed -i` or `cat >` must be caught too. Read-only commands (`ls`, `cat`,
 * `git status`, `npm test`) carry none of these markers.
 * @param {string} command - the shell command.
 * @returns {boolean} whether the command mutates the workspace.
 */
export function shellMutatesWorkspace(command) {
    if (typeof command !== 'string')
        return false;
    const text = command.trim();
    if (text.length === 0)
        return false;
    // Any redirection into a file is a write, regardless of the head verb.
    // `>&2`, `1>&2`, `2>&1` only wire a stream to another stream and never
    // touch the workspace: `npm test 2>&1 | tail` is a read-only test run.
    if (/(?<![\d&])>>?/.test(text))
        return true;
    if (/\b(mkdir|touch|mv|cp|rm|tee|install|ln|patch|truncate|chmod|chown)\b/.test(text))
        return true;
    if (/\bsed\b[^|;&]*\s-i\b/.test(text))
        return true;
    if (/\b(awk|perl|python3?|node)\b[^|;&]*\B/.test(text) && /\s(-i|--in-place)\b/.test(text))
        return true;
    return false;
}

/**
 * The path a shell command would write to, if any. Only redirections name a
 * target directly; the other mutating verbs name theirs as a later argument,
 * which the guard treats as "the workspace as a whole" (undefined path).
 * @param {string} command - the shell command.
 * @returns {string | undefined} the redirect target.
 */
export function shellWriteTarget(command) {
    if (typeof command !== 'string')
        return undefined;
    const match = /(?:^|[^>])>>?\s*([^\s>|;&]+)/.exec(command);
    if (match === null)
        return undefined;
    const target = match[1].replace(/^['"]|['"]$/g, '');
    if (target.length === 0 || target === '/' || target === '-')
        return undefined;
    return target;
}

/** A synthetic path for a shell mutation that names no single file. */
let shellSequence = 0;
function shellMutationPath(exec) {
    const command = exec?.arguments?.command;
    if (typeof command !== 'string')
        return undefined;
    // A read-only command never mutates the workspace: the guard must not
    // count `ls`, `cat` or `npm test` as a file change.
    if (!shellMutatesWorkspace(command))
        return undefined;
    const target = shellWriteTarget(command);
    if (target !== undefined) {
        const workspace = exec?.agent?.session?.header?.cwd ?? process.cwd();
        return isAbsolute(target) ? target : resolve(workspace, target);
    }
    shellSequence += 1;
    return `shell://mutation#${shellSequence}`;
}

/**
 * The path a mutation tool is about to write.
 * @param {Record<string, unknown>} exec - the pending tool execution.
 * @returns {string | undefined} the raw path argument.
 */
export function mutationPath(exec) {
    const args = exec?.arguments;
    if (args === null || typeof args !== 'object')
        return undefined;
    const text = (key) => (typeof args[key] === 'string' ? args[key] : undefined);
    if (exec.name === 'write')
        return text('file_path');
    if (exec.name === 'edit')
        return text('file_path');
    if (exec.name === 'str_replace_editor')
        return text('path');
    return undefined;
}

/**
 * The plain text of a user message.
 * @param {Record<string, any>} message - the inbox message.
 * @returns {string} the concatenated text.
 */
export function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((part) => part && typeof part === 'object' && part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
}

/**
 * The model-facing steering text.
 * @param {string} first - the first file the agent edited.
 * @param {string} next - the file it wanted to edit next.
 * @param {number} attempt - how many times the guard already steered.
 * @returns {string} the denial reason.
 */
export function steeringText(first, next, attempt = 1) {
    const base = `dsh-swarm-autonomy-guard blocked the change of ${next}: this task already touches ${first}, `
        + 'so it is a complex task with more than one independent work item. '
        + 'Dispatch a swarm of agents instead of working through the files one by one '
        + '(including through shell commands such as mv, sed -i or redirections): '
        + 'call swarm_dispatch with ONE run and a DAG of tasks (one task per independent work item, '
        + 'each with its own write scope and acceptance criteria), then collect the result with swarm_wait '
        + 'and verify it. The human did not have to ask for the swarm - deciding that a task is complex is your job.';
    if (attempt <= 1)
        return `${base} If the task really is a single indivisible step, say so and repeat this identical call once.`;
    return `${base} This is attempt ${attempt}: the guard keeps blocking every further file, so the task `
        + 'cannot be finished file by file. Use swarm_dispatch now, or explain in one sentence why this task is '
        + 'a single indivisible step.';
}

/**
 * The prompt marker of the UltraCode working mode.
 *
 * When the mode is on, the agent is expected to organise the work as a plan
 * with parallel parts, so the FIRST mutation is blocked as well: the
 * orchestrator must dispatch a swarm, and every file must then be written by
 * a worker in its own worktree. Without this the orchestrator keeps the
 * first file for itself and writes it straight into the main tree.
 */
export const ULTRACODE_MARKER = 'UltraCode mode is on';

/**
 * Whether the agent's system prompt turns the UltraCode mode on.
 * @param {any} agent - the agent.
 * @returns {boolean} true when the mode is active.
 */
export function ultracodeActive(agent) {
    const session = agent?.session;
    if (session === undefined)
        return false;
    // The effective system prompt lives in the session surface: a list of
    // nodes whose text is resolved through the session event log.
    const nodes = session.surface?.nodes;
    if (Array.isArray(nodes)) {
        for (const seq of nodes) {
            const event = session.eventAt?.(seq);
            const message = event?.data?.message;
            if (message?.role !== 'system')
                continue;
            const content = message.content;
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                if (typeof block?.text === 'string' && block.text.includes(ULTRACODE_MARKER))
                    return true;
            }
        }
        return false;
    }
    // Fallback for hosts that expose the messages directly.
    const messages = session.messages ?? session.history;
    if (!Array.isArray(messages))
        return false;
    for (const message of messages) {
        if (message?.role !== 'system')
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (typeof block?.text === 'string' && block.text.includes(ULTRACODE_MARKER))
                return true;
        }
    }
    return false;
}

/**
 * Install the guard.
 * @param {any} ctx - the plugin context.
 */
export function apply(ctx, config) {
    const debug = (message) => {
        if (config?.debug === true)
            console.log(`[swarm-autonomy-guard] ${message}`);
    };

    ctx.on('agent/created', ({ agent }) => {
        const id = agent?.id ?? agent?.session?.header?.id;
        if (typeof id !== 'string')
            return;
        const state = { prompt: '', files: new Set(), fanout: false, steered: false, blocks: 0 };
        debug(`agent created: ${id}`);

        // A new user prompt starts a new turn: the file counter restarts.
        agent?.dispatch?.on?.('agent/inbox/inserted', ({ message }) => {
            if (message?.source?.kind !== 'user')
                return;
            const text = messageText(message);
            if (text.length === 0)
                return;
            state.prompt = text;
            state.files = new Set();
            state.fanout = false;
            state.steered = false;
            state.blocks = 0;
            debug(`new prompt on ${id}: ${text.slice(0, 60)}`);
        });

        // `tools/pre-execute` is emitted on the AGENT scope, so the listener
        // has to live there too - a root-level listener never sees it.
        const agentCtx = agent?.ctx;
        if (agentCtx === undefined)
            return;
        agentCtx.on('tools/pre-execute', async (exec, next) => {
            debug(`pre-execute: ${exec?.name}`);
            const header = exec?.agent?.session?.header;
            if (header === undefined)
                return next();
            // A swarm worker or a delegated child is already an agent of a
            // swarm: the guard must never steer a worker.
            if (header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0)
                return next();
            if (FANOUT_TOOLS.has(exec.name)) {
                state.fanout = true;
                return next();
            }
            if (state.fanout)
                return next();
            const viaShell = SHELL_TOOLS.has(exec.name);
            if (!MUTATION_TOOLS.has(exec.name) && !viaShell)
                return next();
            const raw = viaShell ? shellMutationPath(exec) : mutationPath(exec);
            if (raw === undefined)
                return next();
            const workspace = header.cwd ?? process.cwd();
            const absolute = raw.startsWith('shell://')
                ? raw
                : (isAbsolute(raw) ? raw : resolve(workspace, raw));
            if (state.files.has(absolute))
                return next();
            if (state.files.size === 0) {
                // In the UltraCode working mode the FIRST file is blocked too:
                // the orchestrator must dispatch a swarm so that every file is
                // written by a worker inside its own worktree and merged back
                // afterwards. A plain session (no UltraCode) keeps the first
                // file: that is an ordinary single-step task.
                if (ultracodeActive(exec?.agent)) {
                    state.steered = true;
                    state.blocks += 1;
                    debug(`blocking the first mutation via ${viaShell ? 'shell' : 'tool'}: ${absolute} (UltraCode mode)`);
                    return {
                        kind: 'deny',
                        reason: `dsh-swarm-autonomy-guard blocked the change of ${absolute}: the UltraCode working mode is on, `
                            + 'so this task must be organised as a swarm of agents instead of a single agent editing files '
                            + 'one by one. Dispatch a swarm of agents FIRST (one swarm_dispatch call with a DAG of tasks, '
                            + 'one task per independent work item), then collect the result with swarm_wait. Every worker '
                            + 'works in its own git worktree and the accepted work is merged back afterwards, so nothing '
                            + 'is lost by delegating.',
                    };
                }
                state.files.add(absolute);
                debug(`first mutation of the turn: ${absolute}`);
                return next();
            }
            const first = [...state.files][0];
            state.steered = true;
            state.blocks += 1;
            debug(`blocking ${absolute} via ${viaShell ? 'shell' : 'tool'} (first was ${first}, block #${state.blocks})`);
            return { kind: 'deny', reason: steeringText(first, absolute, state.blocks) };
        });
    });
}

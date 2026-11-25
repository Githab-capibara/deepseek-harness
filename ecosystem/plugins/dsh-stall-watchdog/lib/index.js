/**
 * dsh-stall-watchdog: a turn that only thinks must not run forever.
 *
 * A model that streams reasoning without ever calling a tool or answering
 * leaves the session spinning: the turn never reaches its stop boundary, so
 * the guards that listen for `agent/turn-stopping` never fire and the user
 * watches a spinner until the session times out.
 *
 * This plugin watches the live assistant stream. When a step has produced
 * reasoning for longer than the configured budget and still has neither a
 * tool call nor an answer, it steers the agent: the turn continues with a
 * message that says what to do instead of thinking. The budget is per step,
 * so a slow but productive turn is never touched, and the plugin only ever
 * speaks once per step.
 *
 * @module dsh-stall-watchdog
 */

import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { name } from './constants.js';

export { name };

/** How long a step may reason without acting before the plugin intervenes. */
const DEFAULT_STALL_MS = 300000;

/** The message the plugin sends when a step only thinks. */
const DEFAULT_NUDGE_TEXT = [
    'Ты уже долго размышляешь без единого действия.',
    'Прекрати рассуждение и ДЕЙСТВУЙ: вызови инструмент, который делает следующий шаг задачи.',
    'Если задача неясна — задай вопрос через ask_user_question;',
    'если нужен план — вызови exit_plan_mode.',
].join(' ');

/** The message the plugin sends when a step only collects refused calls. */
const DEFAULT_REFUSAL_NUDGE_TEXT = [
    'Твой последний вызов инструмента был отклонён: тот же вызов уже не даёт нового результата.',
    'Не повторяй его. Смени стратегию: используй другой инструмент или другой источник данных,',
    'либо дай итоговый ответ по тому, что уже проверено.',
].join(' ');

/** How many refused calls end a turn. */
const DEFAULT_MAX_REFUSALS = 2;

export const Config = z.object({
    /** How long a step may reason without acting before the plugin intervenes. */
    stallMs: z.number().default(DEFAULT_STALL_MS).volatile(),
    /** The message the plugin sends when a step only thinks. */
    nudgeText: z.string().default(DEFAULT_NUDGE_TEXT).volatile(),
    /** How many refused tool calls end a turn before the plugin intervenes. */
    maxRefusals: z.number().default(DEFAULT_MAX_REFUSALS).volatile(),
    /** The message the plugin sends when a step only collects refused calls. */
    refusalNudgeText: z.string().default(DEFAULT_REFUSAL_NUDGE_TEXT).volatile(),
});

/**
 * Read one configuration field, unwrapping the reference the platform wraps a
 * volatile field in.
 *
 * @param {any} field - the raw field value.
 * @param {any} fallback - the value used when the field carries none.
 * @returns {any} the current value.
 */
function readField(field, fallback) {
    if (field === undefined || field === null)
        return fallback;
    if (typeof field === 'object' && typeof field.get === 'function') {
        const value = field.get();
        return value === undefined || value === null ? fallback : value;
    }
    return field;
}

/**
 * The plugin's current configuration.
 *
 * @param {any} raw - the raw second argument of `apply`.
 * @returns {{ stallMs: number, nudgeText: string }} the configuration.
 */
export function readConfig(raw) {
    if (raw === null || typeof raw !== 'object')
        raw = {};
    const stallMs = Number(readField(raw.stallMs, DEFAULT_STALL_MS));
    const maxRefusals = Number(readField(raw.maxRefusals, DEFAULT_MAX_REFUSALS));
    return {
        stallMs: Number.isFinite(stallMs) && stallMs > 0 ? stallMs : DEFAULT_STALL_MS,
        nudgeText: String(readField(raw.nudgeText, DEFAULT_NUDGE_TEXT)),
        maxRefusals: Number.isFinite(maxRefusals) && maxRefusals > 0 ? maxRefusals : DEFAULT_MAX_REFUSALS,
        refusalNudgeText: String(readField(raw.refusalNudgeText, DEFAULT_REFUSAL_NUDGE_TEXT)),
    };
}

/**
 * One step's activity, as the watchdog sees it.
 */
class StepWatch {
    constructor(agent, turn, step) {
        this.agent = agent;
        this.turn = turn;
        this.step = step;
        /** When the step last produced anything. */
        this.lastActivity = Date.now();
        /** Whether the step called a tool or answered. */
        this.acted = false;
        /** Whether the plugin already spoke about this step. */
        this.spoken = false;
        /** How many tool calls came back refused in this step. */
        this.refusals = 0;
    }
}

/**
 * Whether a tool result carries a refusal the model must not retry.
 *
 * The loop guard answers a repeated call with an error that names the
 * repetition, and the text tells the model to stop. The model can still ignore
 * that, so the watchdog counts refusals: a step that only collects refusals
 * makes no progress, and a turn that ends this way must not spin until the
 * turn budget runs out.
 *
 * @param {any} result - the tool execution result.
 * @returns {boolean} whether the result refused the call.
 */
function isRefusal(result) {
    if (result?.isError !== true)
        return false;
    const error = result.error;
    const text = [
        error?.message,
        error?.reason,
        typeof error === 'string' ? error : undefined,
    ].filter((part) => typeof part === 'string').join(' ');
    return /LOOP_GUARD|no productive progress|ACTION REQUIRED|repeated without/i.test(text);
}

/**
 * Install the plugin.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} config - the plugin's configuration.
 * @returns {Promise<void>} resolves once the listener is installed.
 */
export async function apply(ctx, config) {
    const settings = readConfig(config);
    const logger = ctx.logger?.('stall-watchdog');
    const note = (message) => {
        if (logger !== undefined && typeof logger.info === 'function')
            logger.info(message);
    };

    /** The step the watchdog currently watches, per agent. */
    const watches = new WeakMap();

    /**
     * Whether the current turn already produced a tool call.
     *
     * A turn that has already called a tool is working, however long its next
     * step reasons. Only a turn that has produced nothing at all is stalled,
     * so the watchdog must not interrupt a productive turn that pauses.
     */
    const productiveTurns = new WeakMap();

    /** The turn each agent is currently in, so a new turn resets productivity. */
    const lastTurn = new WeakMap();

    /**
     * The watchdog's own state for one agent.
     *
     * @param {any} agent - the agent.
     * @returns {{ current?: StepWatch }} the state.
     */
    const stateOf = (agent) => {
        let state = watches.get(agent);
        if (state === undefined) {
            state = {};
            watches.set(agent, state);
        }
        return state;
    };

    // `agent/pre-step` is a waterfall: the listener must delegate, or the
    // next listener receives no decision at all.
    ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
        const watch = new StepWatch(agent, turn, step);
        // A new turn starts unproductive; a step inside a turn inherits the
        // turn's productivity.
        if (watch.turn !== lastTurn.get(agent)) {
            productiveTurns.set(agent, false);
            lastTurn.set(agent, watch.turn);
        }
        stateOf(agent).current = watch;
        return next();
    });

    // A real tool call marks the turn productive: the agent is acting, and a
    // long pause between calls is not a stall.
    ctx.on('tools/execute', (execution, next) => {
        if (execution?.agent !== undefined)
            productiveTurns.set(execution.agent, true);
        return next();
    });

    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        const state = stateOf(agent);
        const watch = state.current;
        if (watch === undefined)
            return;
        const chunk = frame?.chunk;
        if (chunk === undefined)
            return;
        if (chunk.type === 'tool-call-delta' || chunk.type === 'block-end') {
            // A tool call or a finished block is action: the step is alive.
            if (chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')
                watch.acted = true;
            watch.lastActivity = Date.now();
            return;
        }
        if (chunk.type === 'text-delta') {
            watch.acted = true;
            watch.lastActivity = Date.now();
        }
    });

    // A refused call is not progress. The loop guard tells the model to stop
    // repeating; when the model repeats anyway, the turn has to end, or the
    // agent spends the whole turn budget on the same refusal.
    ctx.on('tools/result', (execution, result) => {
        const agent = execution?.agent;
        if (agent === undefined || !isRefusal(result))
            return;
        const watch = stateOf(agent).current;
        if (watch === undefined)
            return;
        watch.refusals += 1;
        if (watch.refusals < settings.maxRefusals)
            return;
        if (watch.spoken)
            return;
        watch.spoken = true;
        note(`step ${watch.turn}/${watch.step} collected ${watch.refusals} refused calls; ending the turn`);
        try {
            agent.cancel({ kind: 'hook', reason: 'dsh-stall-watchdog: the step only collected refused tool calls' });
            agent.followup(createUserMessage({
                content: [{
                    type: 'text',
                    text: settings.refusalNudgeText,
                }],
                source: { kind: 'user' },
            }));
        }
        catch (error) {
            note(`the refusal interrupt failed: ${String(error)}`);
        }
    });

    ctx.inject(['agents'], (agentCtx) => {
        agentCtx.effect(() => {
            const timer = setInterval(() => {
                const now = Date.now();
                // The service is read through the context that owns it, so the
                // plugin works whether the host exposes it as a property or only
                // through `get`.
                const service = agentCtx.agents ?? ctx.get('agents');
                const agents = service?.list?.() ?? [];
                for (const agent of agents) {
                    const watch = stateOf(agent).current;
                    if (watch === undefined || watch.spoken)
                        continue;
                    // A turn that already called a tool is working, however long
                    // its next step reasons. Only a turn that has produced
                    // nothing at all is stalled.
                    if (productiveTurns.get(agent) === true)
                        continue;
                    if (now - watch.lastActivity < settings.stallMs)
                        continue;
                    watch.spoken = true;
                    note(`turn ${watch.turn} produced nothing for ${Math.round((now - watch.lastActivity) / 1000)}s; interrupting it`);
                    try {
                        // The step is already running, so steering it would only
                        // queue a message for a step that never ends. The turn
                        // is cancelled first and the nudge starts the next one.
                        watch.agent.cancel({ kind: 'hook', reason: 'dsh-stall-watchdog: the step reasoned without acting' });
                        watch.agent.followup(createUserMessage({
                            content: [{ type: 'text', text: settings.nudgeText }],
                            source: { kind: 'user' },
                        }));
                    }
                    catch (error) {
                        note(`the steer failed: ${String(error)}`);
                    }
                }
            }, 15000);
            return () => clearInterval(timer);
        }, 'stall-watchdog: timer');
    });
}

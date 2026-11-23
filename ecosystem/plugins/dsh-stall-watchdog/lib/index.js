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
const DEFAULT_STALL_MS = 180000;

/** The message the plugin sends when a step only thinks. */
const DEFAULT_NUDGE_TEXT = [
    'Ты уже долго размышляешь без единого действия.',
    'Прекрати рассуждение и ДЕЙСТВУЙ: вызови инструмент, который делает следующий шаг задачи.',
    'Если задача неясна — задай вопрос через ask_user_question;',
    'если нужен план — вызови exit_plan_mode.',
].join(' ');

export const Config = z.object({
    /** How long a step may reason without acting before the plugin intervenes. */
    stallMs: z.number().default(DEFAULT_STALL_MS).volatile(),
    /** The message the plugin sends when a step only thinks. */
    nudgeText: z.string().default(DEFAULT_NUDGE_TEXT).volatile(),
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
    return {
        stallMs: Number.isFinite(stallMs) && stallMs > 0 ? stallMs : DEFAULT_STALL_MS,
        nudgeText: String(readField(raw.nudgeText, DEFAULT_NUDGE_TEXT)),
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
    }
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
            logger.info('%s', message);
    };

    /** The step the watchdog currently watches, per agent. */
    const watches = new WeakMap();

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
        stateOf(agent).current = new StepWatch(agent, turn, step);
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

    ctx.inject(['agents'], (agentCtx) => {
        agentCtx.effect(() => {
            const timer = setInterval(() => {
                const now = Date.now();
                const agents = agentCtx.agents?.list?.() ?? [];
                for (const agent of agents) {
                    const watch = stateOf(agent).current;
                    if (watch === undefined || watch.acted || watch.spoken)
                        continue;
                    if (now - watch.lastActivity < settings.stallMs)
                        continue;
                    watch.spoken = true;
                    note(`step ${watch.turn}/${watch.step} reasoned for ${Math.round((now - watch.lastActivity) / 1000)}s without acting; interrupting it`);
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

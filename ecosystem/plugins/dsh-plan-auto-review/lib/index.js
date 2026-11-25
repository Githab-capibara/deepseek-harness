/**
 * dsh-plan-auto-review: a reviewer agent decides the plan, so the phases switch
 * without a human.
 *
 * Plan mode asks the human to approve a plan: `exit_plan_mode` sends the plan
 * through `ctx.userQuestions` and waits for an answer. That answer is what
 * keeps the UltraCode cycle from advancing on its own, and it leaves the agent
 * waiting for a click.
 *
 * This plugin claims the plan-review request before the UI does and answers it
 * with a reviewer's verdict. The reviewer is an ordinary child agent: it reads
 * the plan against the repository and answers `APPROVE` or `REJECT` with the
 * reasons. An approved plan leaves plan mode and the implementation starts. A
 * rejected plan returns the reasons to the planning agent, which revises and
 * presents it again.
 *
 * The human keeps the last word: the request carries the `plan-review` intent,
 * and the plugin answers only that intent. Every other question — a tool
 * approval, a clarification — still reaches the UI.
 *
 * @module dsh-plan-auto-review
 */

import z from '@deepseek-ai/schemastery';
import { name } from './constants.js';

export { name };

/** The intent `exit_plan_mode` marks its question with. */
const PLAN_REVIEW_INTENT = 'plan-review';

/** The option label plan mode offers for approval. */
const APPROVE_LABEL = 'Approve';

/** The option label plan mode offers for "keep planning". */
const KEEP_PLANNING_LABEL = 'Keep planning';

/** How many review rounds one plan may take before the plugin stops claiming it. */
const DEFAULT_MAX_ROUNDS = 3;

/** How long the reviewer may run before the plan reaches the human instead. */
const DEFAULT_REVIEW_TIMEOUT_MS = 300000;

/**
 * Wait for a promise, or report that it did not settle in time.
 *
 * @param {Promise<any>} promise - the work to wait for.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<{ ok: boolean, value?: any }>} the settled value, or a miss.
 */
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise.then((value) => ({ ok: true, value })),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

/** The reviewer agent's brief; the plan and the repository are added to it. */
const DEFAULT_REVIEWER_BRIEF = [
    'You are the reviewer for a plan an agent is about to implement.',
    'Check the plan against the repository, but keep it short.',
    '',
    'Work in at most SIX tool calls: read the two or three files the plan names,',
    'then answer. Do not explore the rest of the repository and do not search',
    'for anything the plan does not name.',
    '',
    'Judge these points:',
    '- Does every referenced file, symbol and command exist?',
    '- Are the write scopes disjoint, and is the plan complete for its goal?',
    '- Does the plan state how the change is verified?',
    '- Are the risky parts identified, with a fallback?',
    '',
    'Answer with your assessment first, then end your reply with EXACTLY one line:',
    'VERDICT: APPROVE   (the plan is sound and complete)',
    'or',
    'VERDICT: REJECT    (the plan needs changes — name precisely what)',
].join('\n');

export const Config = z.object({
    /** How many times one plan may be rejected before the request reaches the human. */
    maxRounds: z.number().default(DEFAULT_MAX_ROUNDS).volatile(),
    /** The reviewer agent's brief; the plan and the repository are added to it. */
    reviewerBrief: z.string().default(DEFAULT_REVIEWER_BRIEF).volatile(),
    /**
     * Whether the plugin turns plan mode on for an agent that has not chosen
     * a mode itself. The UltraCode cycle then runs plan, review, implement and
     * verify without a mode switch by hand.
     */
    autoEnterPlanMode: z.boolean().default(false).volatile(),
    /** How long the reviewer may run before the plan reaches the human instead. */
    reviewTimeoutMs: z.number().default(DEFAULT_REVIEW_TIMEOUT_MS).volatile(),
});

/**
 * Read the reviewed plan out of a plan-review request.
 *
 * @param {any} request - the pending user-question request.
 * @returns {string | undefined} the plan markdown, when the request carries one.
 */
function planOf(request) {
    const questions = request?.questions;
    if (!Array.isArray(questions))
        return undefined;
    for (const question of questions) {
        if (question?.intent?.kind !== PLAN_REVIEW_INTENT)
            continue;
        if (typeof question.detail === 'string' && question.detail.length > 0)
            return question.detail;
    }
    return undefined;
}

/**
 * The question id plan mode uses for its review.
 *
 * @param {any} request - the pending user-question request.
 * @returns {string | undefined} the question id, when the request carries a plan review.
 */
function reviewQuestionId(request) {
    const questions = request?.questions;
    if (!Array.isArray(questions))
        return undefined;
    for (const question of questions) {
        if (question?.intent?.kind === PLAN_REVIEW_INTENT && typeof question.id === 'string')
            return question.id;
    }
    return undefined;
}

/**
 * The label the request offers for approval.
 *
 * @param {any} request - the pending user-question request.
 * @returns {string} the approve label, falling back to plan mode's own wording.
 */
function approveLabel(request) {
    const questions = request?.questions;
    if (Array.isArray(questions)) {
        for (const question of questions) {
            if (question?.intent?.kind !== PLAN_REVIEW_INTENT)
                continue;
            const intent = question.intent;
            if (typeof intent.approve === 'string' && intent.approve.length > 0)
                return intent.approve;
        }
    }
    return APPROVE_LABEL;
}

/**
 * The reasons a reviewer gave, without its verdict line.
 *
 * @param {string} text - the reviewer's reply.
 * @returns {string} the assessment the reviewer wrote.
 */
function assessmentOf(text) {
    const lines = String(text ?? '').trim().split(/\r?\n/);
    const verdictAt = lines.findIndex((line) => /^VERDICT:\s*(APPROVE|REJECT)\s*$/i.test(line.trim()));
    const assessment = (verdictAt === -1 ? lines : lines.slice(0, verdictAt)).join('\n').trim();
    return assessment;
}

/**
 * The verdict a reviewer gave.
 *
 * @param {string} text - the reviewer's reply.
 * @returns {'approve' | 'reject' | undefined} the verdict, when the reviewer stated one.
 */
function verdictOf(text) {
    const lines = String(text ?? '').trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = lines[index].trim().match(/^VERDICT:\s*(APPROVE|REJECT)\s*$/i);
        if (match !== null)
            return match[1].toLowerCase();
    }
    return undefined;
}

/**
 * Build the answer plan mode accepts for an approved plan.
 *
 * @param {string} questionId - the reviewed question's id.
 * @param {string} label - the approve option's label.
 * @returns {{ answers: { id: string, selected: string[] }[] }} the answer.
 */
function approveAnswer(questionId, label) {
    return { answers: [{ id: questionId, selected: [label] }] };
}

/**
 * Build the answer plan mode accepts for a rejected plan.
 *
 * @param {string} questionId - the reviewed question's id.
 * @param {string} feedback - the reviewer's reasons.
 * @returns {{ answers: { id: string, selected: string[], custom: string }[] }} the answer.
 */
function rejectAnswer(questionId, feedback) {
    return {
        answers: [{
            id: questionId,
            selected: [KEEP_PLANNING_LABEL],
            custom: feedback,
        }],
    };
}

/**
 * The text a child agent produced.
 *
 * @param {any} result - the child's result.
 * @returns {string} the child's assistant text.
 */
function outputText(result) {
    if (typeof result === 'string')
        return result;
    const output = result?.output;
    if (!Array.isArray(output))
        return '';
    return output
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

/**
 * Read one configuration field, unwrapping the reference the platform wraps a
 * volatile field in.
 *
 * The platform hands a volatile field to the plugin as a reference, because it
 * replaces the value in place when the operator edits it. The plugin therefore
 * unwraps it at every read instead of caching it once.
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
 * @returns {{ maxRounds: number, reviewerBrief: string, autoEnterPlanMode: boolean }} the configuration.
 */
export function readConfig(raw) {
    if (raw === null || typeof raw !== 'object')
        raw = {};
    const maxRounds = Number(readField(raw.maxRounds, DEFAULT_MAX_ROUNDS));
    const reviewTimeoutMs = Number(readField(raw.reviewTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS));
    return {
        maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : DEFAULT_MAX_ROUNDS,
        reviewerBrief: String(readField(raw.reviewerBrief, DEFAULT_REVIEWER_BRIEF)),
        autoEnterPlanMode: readField(raw.autoEnterPlanMode, false) === true,
        reviewTimeoutMs: Number.isFinite(reviewTimeoutMs) && reviewTimeoutMs > 0
            ? reviewTimeoutMs
            : DEFAULT_REVIEW_TIMEOUT_MS,
    };
}

/**
 * Install the plugin.
 *
 * @param {any} ctx - the plugin context.
 * @param {any} config - the plugin's configuration.
 * @returns {Promise<void>} resolves once the listener is installed.
 */
export async function apply(ctx, config) {
    // The plugin's configuration arrives as raw references for its volatile
    // fields, so every read unwraps them.
    const settings = readConfig(config);
    const maxRounds = settings.maxRounds;
    const brief = settings.reviewerBrief;
    const autoEnterPlanMode = settings.autoEnterPlanMode;
    const reviewTimeoutMs = settings.reviewTimeoutMs;
    const logger = ctx.logger?.('plan-auto-review');
    const note = (message) => {
        // The plugin reports on stderr: the loader's own log level is off in
        // most profiles, and a review decision the operator cannot see is a
        // decision they cannot trust.
        process.stderr.write(`[plan-auto-review] ${message}\n`);
        if (logger !== undefined && typeof logger.info === 'function')
            logger.info('%s', message);
    };
    note(`applied; config=${JSON.stringify(config)}`);
    const warn = (message) => {
        process.stderr.write(`[plan-auto-review] ${message}\n`);
        if (logger !== undefined && typeof logger.warn === 'function')
            logger.warn('%s', message);
    };

    // Plan mode is disclosed progressively: the exit tool is admitted from the
    // first step whose selected state is active. Turning the mode on when the
    // agent appears therefore puts the whole plan, review and implement cycle
    // within reach of the first step.
    //
    // The plan-mode service may not be mounted yet when this plugin applies,
    // so the listener waits for it instead of reading it once.
    if (autoEnterPlanMode) {
        note('waiting for the plan-mode service');
        ctx.inject(['planMode'], (planCtx) => {
            const planMode = planCtx.planMode;
            note('the plan-mode service is available');
            planCtx.on('agent/created', ({ agent }) => {
                if (planMode.get(agent).active)
                    return;
                const outcome = planMode.set(agent, true);
                if (outcome === 'committed')
                    note(`plan mode turned on for ${agent.id}`);
                else if (outcome === 'queued')
                    note(`plan mode queued for ${agent.id}`);
                else
                    note(`plan mode selection for ${agent.id}: ${outcome}`);
            });
        });
    }

    // One plan may be rejected a few times; the counter is per plan, so a
    // later plan starts fresh.
    const rounds = new Map();

    // The listener is prepended and global: the UI's answerer registers
    // earlier, and a waterfall lets the first listener that does not delegate
    // decide. The plugin sits outside every isolation group, so it sees the
    // request whichever agent scope raised it.
    ctx.on('user-questions/request', async (request, next) => {
        const plan = planOf(request);
        if (plan === undefined)
            return next();
        const questionId = reviewQuestionId(request);
        if (questionId === undefined)
            return next();

        const key = `${request.agent?.id ?? 'root'}:${questionId}`;
        const count = (rounds.get(key) ?? 0) + 1;
        if (count > maxRounds) {
            warn(`the plan was reviewed ${maxRounds} times; the human decides now`);
            rounds.delete(key);
            return next();
        }
        rounds.set(key, count);

        const subagents = ctx.get('subagents');
        if (subagents === undefined || typeof subagents.startActivation !== 'function') {
            warn('no subagents service; the human decides the plan');
            return next();
        }
        const parent = request.agent;
        if (parent === undefined) {
            warn('the plan review carries no agent; the human decides the plan');
            return next();
        }

        let review;
        try {
            review = await subagents.startActivation({
                provider: 'spawn',
                label: 'plan-reviewer',
                name: 'plan-reviewer',
                parent,
                prompt: [{
                    type: 'text',
                    text: `${brief}\n\n## The plan under review\n\n${plan}`,
                }],
                signal: request.signal ?? new AbortController().signal,
                delivery: 'caller',
            });
        }
        catch (error) {
            warn(`the reviewer agent failed to start; the human decides the plan: ${String(error)}`);
            return next();
        }

        try {
            const settled = await withTimeout(review.result, reviewTimeoutMs);
            if (!settled.ok) {
                // A reviewer that does not finish must not hold the session
                // hostage: the plan reaches the human instead.
                warn(`the reviewer did not answer within ${reviewTimeoutMs} ms; the human decides the plan`);
                rounds.delete(key);
                return next();
            }
            const result = settled.value;
            const text = outputText(result);
            const verdict = verdictOf(text);
            const assessment = assessmentOf(text);
            const label = approveLabel(request);
            if (verdict === 'approve') {
                note(`the reviewer approved the plan (round ${count})`);
                rounds.delete(key);
                return approveAnswer(questionId, label);
            }
            if (verdict === 'reject') {
                note(`the reviewer rejected the plan (round ${count}): ${assessment.slice(0, 200)}`);
                const feedback = assessment.length > 0
                    ? assessment
                    : 'The reviewer rejected the plan without naming a reason; make the plan concrete before presenting it again.';
                // Plan mode reads the free-text answer as the feedback the
                // planning agent receives, and stays in plan mode.
                return rejectAnswer(questionId, feedback);
            }
            warn('the reviewer stated no verdict; the human decides the plan');
            rounds.delete(key);
            return next();
        }
        finally {
            try {
                review.dispose?.();
            }
            catch (error) {
                warn(`the reviewer agent could not be disposed: ${String(error)}`);
            }
        }
    }, { prepend: true, global: true });
}

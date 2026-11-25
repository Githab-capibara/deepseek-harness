// Русский словарь для панелей плагинов, которых нет в dsh-russian-lang.
//
// Названия технологий, API, команд, форматов и продуктов остаются на
// английском (swarm, worktree, token, commit, git, npm, MCP, UltraCode,
// prompt, tool, plugin, session, provider, agent, subagent, model, context,
// plan, review, gate, stream, timeout, retry, CI/CD, ...). Всё остальное —
// по-русски.
//
// Только видимый интерфейс: системные инструкции агента не затрагиваются.
import { SWARM_RU } from './tables/swarm.js';
import { BASELINE_RU } from './tables/baseline.js';
import { CONTEXT_DECAY_RU } from './tables/context-decay.js';
import { SESSION_RETRY_RU } from './tables/session-retry.js';
import { STALL_GUARD_RU } from './tables/stall-guard.js';
import { LOOP_GUARD_RU } from './tables/loop-guard.js';
import { AUTO_REVIEW_RU } from './tables/auto-review.js';
import { PROTECT_TESTS_RU } from './tables/protect-tests.js';

/** @type {Record<string, Record<string, string>>} */
export const TRANSLATIONS = {
    'swarm': SWARM_RU,
    'dsh-baseline': BASELINE_RU,
    'contextDecay': CONTEXT_DECAY_RU,
    'session-retry': SESSION_RETRY_RU,
    'dsh.stallGuard': STALL_GUARD_RU,
    '@goodandready/dsh-agent-loop-guard': LOOP_GUARD_RU,
    'autoReviewPanel': AUTO_REVIEW_RU,
    'plugin.dsh-protect-tests': PROTECT_TESTS_RU,
};

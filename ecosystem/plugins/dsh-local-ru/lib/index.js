/**
 * dsh-local-ru: русская локализация плагинов, которых нет в dsh-russian-lang.
 *
 * @goodandready/dsh-russian-lang переводит ядро DSH и 101 сторонний плагин,
 * но в его инвентаре нет плагинов из моего стека (swarm-orchestrator,
 * baseline, context-decay, session-retry, stall-guard, second-review,
 * agent-loop-guard, auto-review, agent-frugality, verify-kit, verify-judge,
 * protect-tests, task-reliability, ultracode, subagent-guard, stalegreen).
 * Их интерфейс оставался английским.
 *
 * Этот плагин регистрирует словари `ru` для namespace'ов этих плагинов.
 *
 * Правило перевода: названия технологий, API, команд, файлов и форматов
 * остаются на английском (swarm, worktree, token, commit, git, npm, MCP,
 * UltraCode, prompt, tool, plugin, session, provider, agent, subagent,
 * model, context, plan, review, gate, stream, timeout, retry, CI/CD и т.п.).
 * Всё остальное — по-русски.
 *
 * @module dsh-local-ru
 */
import { TRANSLATIONS } from './translations.js';

export const name = 'dsh-local-ru';

/**
 * Install the plugin.
 *
 * The plugin is a client half: it registers the Russian dictionaries into the
 * locale runtime of the browser. The host half only carries the schema.
 * @param {any} ctx - the plugin context.
 * @param {any} config - the plugin configuration.
 */
export function apply(ctx, config) {
    if (config?.enabled === false)
        return;
    // The client half is loaded through the `dsh.client` declaration in
    // package.json; the host half has nothing to register.
}

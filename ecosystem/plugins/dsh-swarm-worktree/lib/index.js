/**
 * dsh-swarm-worktree: one git worktree per swarm task agent.
 *
 * The swarm runs several builder agents in parallel. Without filesystem
 * isolation they all write into ONE working tree, so two tasks that touch
 * different files still race on the same index, and a task that is later
 * rejected leaves half-finished changes behind. This plugin gives every task
 * agent its OWN git worktree:
 *
 *   1. `swarm_dispatch` creates a run whose dispatch cwd is the repository.
 *      The plugin watches the swarm's task lifecycle.
 *   2. When a task agent is spawned, the plugin acquires a worktree for it
 *      (`ctx.worktree.acquire`), so the child session runs with `cwd` set to
 *      that worktree and cannot touch the parent's working tree.
 *   3. The child PROMPT is extended with the worktree facts (its own path,
 *      its branch, and the rule "commit your work on your branch").
 *   4. When a task is ACCEPTED (task/completed without review rejection) the
 *      plugin merges that task's branch into the target branch of the
 *      repository, so the orchestrator's tree ends up holding every accepted
 *      change.
 *
 * Everything degrades to "no worktree" when the workspace is not a git
 * repository: an ordinary task in a plain directory must keep working.
 *
 * @module dsh-swarm-worktree
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const name = 'swarm-worktree';

/** How long a git command may run before it is treated as failed. */
const GIT_TIMEOUT_MS = 120000;

/**
 * Run a git command inside a directory.
 * @param {string} cwd - the working directory.
 * @param {string[]} args - the git arguments.
 * @returns {Promise<string>} stdout, or an empty string on failure.
 */
export async function git(cwd, args) {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
        });
        return stdout.trim();
    }
    catch {
        return '';
    }
}

/**
 * The repository root that owns a directory, or undefined when there is none.
 * @param {string} cwd - the directory to inspect.
 * @returns {Promise<string | undefined>} the repository root.
 */
export async function repoRootOf(cwd) {
    const out = await git(cwd, ['rev-parse', '--show-toplevel']);
    return out.length > 0 ? out : undefined;
}

/**
 * The branch that is currently checked out.
 * @param {string} cwd - the repository directory.
 * @returns {Promise<string | undefined>} the branch name.
 */
export async function currentBranch(cwd) {
    const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.length > 0 && out !== 'HEAD' ? out : undefined;
}

/**
 * The slug of a worktree: the task id plus the attempt, so a retried task
 * never reuses a stale tree.
 * @param {string} taskId - the swarm task id.
 * @param {string} attemptId - the attempt id.
 * @returns {string} a slug accepted by dsh-worktree.
 */
export function worktreeSlug(taskId, attemptId) {
    const safeTask = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
    const safeAttempt = String(attemptId ?? 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    return `swarm-${safeTask}-${safeAttempt}`;
}

/**
 * The prompt fragment that tells the worker about its worktree.
 * @param {object} facts - the worktree facts.
 * @returns {string} the prompt fragment.
 */
export function worktreeBrief(facts) {
    return [
        '',
        '## Your isolated worktree',
        '',
        `You are working in YOUR OWN git worktree, not in the orchestrator's working tree:`,
        `- worktree path: \`${facts.path}\``,
        `- your branch: \`${facts.branch}\``,
        '',
        'Rules:',
        '1. Every path you write is inside that worktree. Do NOT try to reach the',
        '   orchestrator tree, another worker\'s worktree, or any absolute path',
        '   outside your worktree - your writes there are rejected.',
        '2. When your task is done, COMMIT your changes on your own branch',
        '   (`git add -A && git commit -m "<task id>: <what you did>"`). The',
        '   orchestrator merges your branch into the target branch after your task',
        '   is accepted, so an uncommitted change would be lost.',
        '3. Your report file and your evidence commands are resolved against THIS',
        '   worktree, so relative paths work as written.',
    ].join('\n');
}

/**
 * Install the plugin.
 * @param {any} ctx - the plugin context.
 * @param {any} config - the plugin configuration.
 */
export function apply(ctx, config) {
    const logger = ctx.logger?.('swarm-worktree');
    const debug = (message) => {
        if (config?.debug !== true)
            return;
        if (logger !== undefined && typeof logger.info === 'function')
            logger.info('%s', message);
        else
            console.log(`[swarm-worktree] ${message}`);
    };
    console.log('[swarm-worktree] plugin applied');
    debug('plugin applied');
    const mergeOnAccept = config?.mergeOnAccept !== false;
    const configuredTarget = typeof config?.targetBranch === 'string' ? config.targetBranch.trim() : '';

    /** runId -> { cwd, repoRoot, target } */
    const runs = new Map();
    /** repoRoot -> Map<`${taskId}@${branch}`, record> */
    const leasesByRepo = new Map();
    /** childSessionId -> record */
    const children = new Map();

    const worktreeService = () => {
        // The worktree service lives in the host composition; a plugin scope
        // may not see it directly, so every candidate scope is tried.
        const candidates = [ctx];
        let scoped;
        try {
            scoped = ctx.scope?.();
        }
        catch (_scopeUnavailable) {
            // A context without a scope accessor resolves the service itself.
        }
        if (scoped !== undefined)
            candidates.push(scoped);
        for (const candidate of candidates) {
            let found;
            try {
                found = candidate.get('worktree');
            }
            catch (_serviceUnreachable) {
                // This scope cannot resolve the service; the next candidate may.
            }
            if (found !== undefined)
                return found;
        }
        return undefined;
    };

    // ── 1. Spawn interception ───────────────────────────────────────────
    // The swarm calls `ctx.get('subagents').start('spawn', request)`. The
    // request carries the task label (`swarm:<taskId>`) and the parent's cwd.
    // Here the worktree for that task is acquired and the child's cwd is
    // switched to it BEFORE the child session is created, so every tool the
    // worker runs already sees the isolated tree.
    /**
     * Wrap the swarm's spawn dependency so every task agent starts in its own
     * worktree.
     *
     * The swarm calls `this.spawnDeps().start(request)` for every task and
     * reviewer agent. That is the ONE place where a child session is created,
     * so wrapping it covers every worker without touching the subagents
     * service (whose provider object exposes no `start`).
     * @param {any} swarm - the swarm service.
     * @returns {boolean} whether the dependency was wrapped.
     */
    const patchSwarmSpawn = (swarm) => {
        if (swarm === undefined || swarm === null)
            return false;
        if (typeof swarm.spawnDeps !== 'function') {
            console.log('[swarm-worktree] swarm.spawnDeps is not a function');
            return false;
        }
        if (swarm.__swarmWorktreeSpawnPatched === true)
            return true;
        // The orchestrator may run on a DIFFERENT service instance than the
        // one this scope resolves (the swarm plugin lives in its own scope).
        // Patching the prototype covers every instance.
        const proto = Object.getPrototypeOf(swarm);
        if (proto === null || typeof proto.spawnDeps !== 'function') {
            console.log(`[swarm-worktree] no spawnDeps on the prototype (${proto === null ? 'null' : typeof proto})`);
            return false;
        }
        console.log(`[swarm-worktree] prototype patched: ${proto.constructor?.name ?? '?'}`);
        if (proto.__swarmWorktreeSpawnPatched === true)
            return true;
        const original = proto.spawnDeps;
        proto.spawnDeps = function patchedSpawnDeps() {
            console.log('[swarm-worktree] spawnDeps() called');
            const deps = original.call(this);
            const start = deps.start;
            deps.start = async (request) => {
                const label = typeof request?.label === 'string' ? request.label : '';
                console.log(`[swarm-worktree] deps.start label=${label}`);
                if (!label.startsWith('swarm:'))
                    return start(request);
                debug(`[swarm-worktree] spawn label=${label}`);
                try {
                    const rewritten = await withWorktree(request);
                    return start(rewritten);
                }
                catch (error) {
                    console.log(`[swarm-worktree] withWorktree failed for ${label}: ${String(error)}`);
                    return start(request);
                }
            };
            return deps;
        };
        swarm.__swarmWorktreeSpawnPatched = true;
        proto.__swarmWorktreeSpawnPatched = true;
        debug('swarm.spawnDeps() intercepted');
        console.log('[swarm-worktree] swarm.spawnDeps() intercepted (prototype)');
        return true;
    };

    /**
     * Attach a worktree to a spawn request.
     * @param {any} request - the subagent start request.
     * @returns {Promise<any>} the (possibly rewritten) request.
     */
    const withWorktree = async (request) => {
        if (request === undefined || request === null)
            return request;
        const label = typeof request.label === 'string' ? request.label : '';
        if (!label.startsWith('swarm:'))
            return request;
        const taskId = label.slice('swarm:'.length);
        const parent = request.parent;
        const parentCwd = parent?.session?.header?.cwd;
        debug(`[swarm-worktree] withWorktree task=${taskId} parentCwd=${parentCwd ?? '(none)'}`);
        const cwd = request.cwd ?? parentCwd;
        if (typeof cwd !== 'string') {
            debug(`[swarm-worktree] no cwd for ${taskId} (request.cwd=${request.cwd}, parent.cwd=${parentCwd})`);
            return request;
        }
        const repoRoot = await repoRootOf(cwd);
        if (repoRoot === undefined) {
            console.log(`[swarm-worktree] no git repo at ${cwd} — no worktree for ${taskId}`);
            return request;
        }
        const worktrees = worktreeService();
        if (worktrees === undefined) {
            console.log('[swarm-worktree] ctx.worktree service is NOT available — no worktree');
            return request;
        }
        debug(`[swarm-worktree] acquiring worktree for ${taskId} in ${repoRoot}`);
        const attemptId = request.attemptId ?? request.attempt ?? 'x';
        const slug = worktreeSlug(taskId, attemptId);
        let lease;
        try {
            lease = await worktrees.acquire(slug, repoRoot);
        }
        catch (error) {
            console.log(`[swarm-worktree] acquire failed for ${slug}: ${String(error)}`);
            return request;
        }
        const entry = lease.entry;
        const facts = {
            path: entry.path,
            branch: entry.branch,
            repoRoot,
            taskId,
        };
        debug(`[swarm-worktree] worktree for ${taskId}: ${entry.path} (${entry.branch})`);
        // Remember the lease so the merge step can find the branch later. The
        // run is identified by the repository root + the dispatch cwd, because
        // the swarm's spawn request carries no run id: the orchestrator's
        // anchor agent is the parent of every task agent.
        const record = {
            taskId,
            slug,
            lease,
            facts,
            repoRoot,
            branch: entry.branch,
            merged: false,
        };
        // Index by repo root, so the merge step can find the record for the
        // run that owns this repository.
        let byRepo = leasesByRepo.get(repoRoot);
        if (byRepo === undefined) {
            byRepo = new Map();
            leasesByRepo.set(repoRoot, byRepo);
        }
        byRepo.set(`${taskId}@${entry.branch}`, record);
        children.set(String(request.childId ?? ''), record);
        debug(`worktree for task ${taskId}: ${entry.path} (${entry.branch})`);
        const prompt = Array.isArray(request.prompt)
            ? [...request.prompt]
            : (request.prompt === undefined ? undefined : [request.prompt]);
        if (prompt !== undefined) {
            const brief = { type: 'text', text: worktreeBrief(facts) };
            const first = prompt[0];
            if (first !== undefined && typeof first === 'object' && typeof first.text === 'string') {
                prompt[0] = { ...first, text: `${first.text}\n${brief.text}` };
            }
            else {
                prompt.push(brief);
            }
        }
        return { ...request, cwd: entry.path, prompt };
    };

    // ── 2. Merge on accept ──────────────────────────────────────────────
    /**
     * Merge one task branch into the target branch of the repository.
     * @param {object} record - the task's worktree record.
     * @param {string} target - the branch to merge into.
     * @returns {Promise<string>} a short report of what happened.
     */
    const mergeBranch = async (record, target) => {
        const repoRoot = record.repoRoot;
        const branch = record.branch;
        const worktreePath = record.facts.path;
        // The worker must have committed; an empty branch means no work.
        const commits = await git(worktreePath, ['rev-list', '--count', `${target}..${branch}`]);
        if (commits === '' || commits === '0')
            return 'no commits to merge';
        // Merge from the repository root so the target branch is not checked
        // out in the worktree itself.
        const merge = await git(repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
        if (merge.length === 0) {
            // A conflicting merge leaves the repository mid-merge: abort it so
            // the tree stays usable and report the conflict.
            await git(repoRoot, ['merge', '--abort']);
            return 'merge conflict — aborted, branch left for manual resolution';
        }
        return `merged ${commits} commit(s) into ${target}`;
    };

    /**
     * Release the worktree a closed task used, and its branch when target holds it.
     *
     * `ctx.worktree.acquire` allocates a checkout and a branch and removes
     * neither on its own, so without this step every task of every run leaves
     * one directory under `.dsh/worktrees/` and one branch behind. The branch
     * survives when `target` does not contain it: a conflicting merge leaves
     * the branch for manual resolution, and a run that failed before its tasks
     * were accepted may hold finished work that was never merged.
     * @param {any} record - the worktree record of the closed task.
     * @param {string} target - the branch the work merged into.
     * @returns {Promise<string>} what happened, for the operator log.
     */
    const releaseWorktree = async (record, target) => {
        const { repoRoot, branch } = record;
        const path = record.facts?.path;
        // The repository root is never a lease target; the guard keeps a
        // malformed record from removing the checkout the run works in.
        if (typeof path !== 'string' || path === repoRoot)
            return 'refused: record has no worktree path';
        // Confirm the checkout is a registered worktree of this repository
        // before touching the filesystem, so a stale record removes nothing.
        const listed = await git(repoRoot, ['worktree', 'list', '--porcelain']);
        const registered = listed.split('\n').some((line) => line.startsWith('worktree ')
            && line.slice('worktree '.length).trim() === path);
        if (!registered)
            return 'already released';
        // `git branch --merged` prints the branch only when target reaches it;
        // the empty-output-on-failure contract of the git helper cannot tell an
        // exit-1 `merge-base --is-ancestor` from success.
        const held = await git(repoRoot, ['branch', '--merged', target, '--list', branch]);
        const merged = held.split('\n').some((line) => line.trim().replace(/^[*+] /, '') === branch);
        // A worker leaves untracked residue (build output, `node_modules`), so
        // `git worktree remove` refuses the checkout without a force.
        await git(repoRoot, ['worktree', 'remove', '--force', '--', path]);
        if (!merged)
            return `worktree removed; branch ${branch} kept (not contained by ${target})`;
        await git(repoRoot, ['branch', '-D', branch]);
        return 'worktree and branch released';
    };

    // ── 3. Lifecycle wiring ─────────────────────────────────────────────
    ctx.on('agent/created', ({ agent }) => {
        const id = agent?.id ?? agent?.session?.header?.id;
        if (typeof id !== 'string')
            return;
        const header = agent?.session?.header;
        if (header?.origin !== 'subagent')
            return;
        // A swarm worker announces itself through the swarm plugin's own
        // event; the worktree record is keyed by the child's session id.
        const record = children.get(id);
        if (record === undefined)
            return;
        record.childSessionId = id;
        debug(`worker ${id} runs in ${record.facts.path}`);
    });

    // No subagents guard here: `withWorktree` resolves the working directory
    // from the spawn request (its own `cwd`, else the parent session's), and
    // the wiring below only touches the swarm service and its event store. A
    // `ctx.get('subagents')` check used to return early whenever the service
    // was visible, which silently disabled the merge and the release in every
    // host that exposes it.

    // The swarm service owns the task lifecycle; the merge happens when the
    // orchestrator accepts a task. The event store is the single source of
    // truth for that transition.
    // The swarm service may live in a different scope than this plugin, so
    // every known scope candidate is probed.
    const swarmService = () => {
        const candidates = [ctx];
        let scoped;
        try {
            scoped = ctx.scope?.();
        }
        catch (_scopeUnavailable) {
            // A context without a scope accessor resolves the service itself.
        }
        if (scoped !== undefined)
            candidates.push(scoped);
        for (const candidate of candidates) {
            let found;
            try {
                found = candidate.get('swarm');
            }
            catch (_serviceUnreachable) {
                // This scope cannot resolve the service; the next candidate may.
            }
            if (found !== undefined)
                return found;
        }
        return undefined;
    };

    /**
     * Run the evidence commands of a task INSIDE that task's worktree.
     *
     * Upstream the dispatcher always runs the evidence in the run's dispatch
     * cwd (the main tree). With worktree isolation the worker's changes live
     * in its own worktree, so the evidence would inspect the untouched main
     * tree and fail ("the function does not exist").
     * @param {any} swarm - the swarm service.
     * @returns {boolean} whether the check was wrapped.
     */
    const patchEvidence = (swarm) => {
        if (swarm === undefined || swarm === null)
            return false;
        if (typeof swarm.checkEvidence !== 'function')
            return false;
        if (swarm.__swarmWorktreeEvidencePatched === true)
            return true;
        const original = swarm.checkEvidence.bind(swarm);
        swarm.checkEvidence = async (task, signal, onCleanupFailed) => {
            const record = recordForTask(task);
            if (record === undefined)
                return original(task, signal, onCleanupFailed);
            // The evidence must see the worker's tree, so the dispatch cwd of
            // the run is temporarily pointed at the worktree.
            const state = swarm.view?.();
            const run = state?.runs?.get(task.runId);
            const dispatch = run?.dispatch;
            if (dispatch === undefined)
                return original(task, signal, onCleanupFailed);
            const originalCwd = dispatch.cwd;
            dispatch.cwd = record.facts.path;
            try {
                return await original(task, signal, onCleanupFailed);
            }
            finally {
                dispatch.cwd = originalCwd;
            }
        };
        swarm.__swarmWorktreeEvidencePatched = true;
        debug('swarm.checkEvidence() redirected into the worktree');
        return true;
    };

    /**
     * The worktree record of a task, if the task has one.
     * @param {any} task - the swarm task.
     * @returns {any} the record or undefined.
     */
    const recordForTask = (task) => {
        const taskId = task?.id;
        if (typeof taskId !== 'string')
            return undefined;
        for (const byRepo of leasesByRepo.values()) {
            for (const record of byRepo.values()) {
                if (record.taskId === taskId)
                    return record;
            }
        }
        return undefined;
    };

    /**
     * Fail a task that was closed without any committed work.
     *
     * Upstream accepts a task whose worker ended its turn without doing
     * anything ("completed" with an empty summary). With worktree isolation
     * that is visible: the task branch has no commits. Such a task is failed
     * so the orchestrator retries it or blocks for a human, instead of the
     * run reporting a result that does not contain the requested work.
     * @param {any} swarm - the swarm service.
     * @param {string} runId - the run id.
     * @param {string} taskId - the task id.
     */
    const failTask = async (swarm, runId, taskId) => {
        try {
            const state = swarm.view?.();
            const task = state?.tasks?.get(`${runId}/${taskId}`);
            if (task === undefined || task.status !== 'completed')
                return;
            const events = swarm.events;
            if (events === undefined || typeof events.append !== 'function')
                return;
            events.append('task/failed', {
                runId,
                taskId,
                data: {
                    source: 'operator',
                    retry: true,
                    reason: 'the worker closed the task without committing any work in its worktree',
                },
            });
            swarm.scheduleTick?.();
        }
        catch (error) {
            console.log(`[swarm-worktree] could not fail the empty task ${taskId}: ${String(error)}`);
        }
    };

    const wireSwarm = (swarm) => {
        if (swarm === undefined || swarm === null)
            return;
        if (swarm.__swarmWorktreeWired === true)
            return;
        swarm.__swarmWorktreeWired = true;
        // The swarm resolves the subagents service from ITS OWN scope, which
        // can be a different service instance than the one this plugin sees.
        // Patch that instance too, otherwise the interception never fires.
        const patchSwarmScope = () => {
            patchSwarmSpawn(swarm);
            patchEvidence(swarm);
        };
        patchSwarmScope();
        let scopeAttempts = 0;
        const scopeTimer = setInterval(() => {
            scopeAttempts += 1;
            patchSwarmScope();
            if (scopeAttempts > 100)
                clearInterval(scopeTimer);
        }, 200);
        scopeTimer.unref?.();
        const store = swarm.events;
        if (store === undefined || typeof store.subscribe !== 'function') {
            debug('swarm event store is not observable; worktree merge disabled');
            return;
        }
        store.subscribe((event) => {
            if (!mergeOnAccept)
                return;
            // `task/completed` is the normal acceptance. `task/blocked` can
            // also carry finished work: the upstream cleanup check may fail
            // ("child cleanup could not be confirmed") AFTER the worker has
            // committed everything. The branch is inspected in either case,
            // so the merge happens whenever the branch actually holds commits.
            if (event?.kind !== 'task/completed' && event?.kind !== 'task/blocked')
                return;
            void onTaskEvent(event);
        });
        /**
         * Report the leases a finished run left behind.
         *
         * A run can close while its tasks were never accepted — the provider
         * outage takes every worker down, for instance. Those branches may
         * hold committed work that was never merged, so nothing is removed
         * here: the leftover worktree and branch are reported instead, because
         * silently discarding finished work is worse than visible residue.
         * @param {any} event - the swarm run event.
         */
        const onRunEvent = async (event) => {
            if (event?.kind !== 'run/completed' && event?.kind !== 'run/failed' && event?.kind !== 'run/aborted')
                return;
            const runId = event?.runId;
            if (typeof runId !== 'string')
                return;
            let state;
            try {
                state = swarm.view();
            }
            catch {
                return;
            }
            const run = state?.runs?.get(runId);
            const cwd = run?.dispatch?.cwd;
            if (typeof cwd !== 'string')
                return;
            const repoRoot = await repoRootOf(cwd);
            if (repoRoot === undefined)
                return;
            const byRepo = leasesByRepo.get(repoRoot);
            if (byRepo === undefined)
                return;
            for (const record of byRepo.values()) {
                if (record.released !== undefined || record.merged === true)
                    continue;
                console.log(`[swarm-worktree] run ${runId} (${event.kind}) left worktree ${record.facts.path} on branch ${record.branch}; `
                    + 'inspect it — its work was never merged, so it is kept, not removed');
            }
        };
        store.subscribe((event) => {
            void onRunEvent(event);
        });
        /**
         * Handle an accepted swarm task: merge its branch into main.
         * @param {any} event - the swarm event.
         */
        const onTaskEvent = async (event) => {
            const taskId = event?.taskId;
            const runId = event?.runId;
            if (typeof taskId !== 'string' || typeof runId !== 'string')
                return;
            let state;
            try {
                state = swarm.view();
            }
            catch {
                return;
            }
            const run = state?.runs?.get(runId);
            if (run === undefined)
                return;
            // Only an ACCEPTED task may be merged. A task that went through a
            // strict review and was rejected is not `completed`.
            const task = state?.tasks?.get(`${runId}/${taskId}`);
            if (task !== undefined && event?.kind === 'task/completed') {
                const accepted = task.status === 'completed'
                    && (task.acceptanceState === undefined || task.acceptanceState === 'accepted');
                if (!accepted)
                    return;
            }
            const cwd = run.dispatch?.cwd;
            if (typeof cwd !== 'string')
                return;
            let runInfo = runs.get(runId);
            if (runInfo === undefined) {
                const repoRoot = await repoRootOf(cwd);
                if (repoRoot === undefined)
                    return;
                const target = configuredTarget.length > 0
                    ? configuredTarget
                    : (await currentBranch(repoRoot)) ?? 'main';
                runInfo = { cwd, repoRoot, target };
                runs.set(runId, runInfo);
            }
            const byRepo = leasesByRepo.get(runInfo.repoRoot);
            if (byRepo === undefined)
                return;
            // The record is keyed by task id AND branch; the branch is not
            // known from the event, so the task id alone is enough because a
            // task id appears once per run and a run owns one repository.
            let record;
            for (const candidate of byRepo.values()) {
                if (candidate.taskId === taskId && candidate.merged !== true) {
                    record = candidate;
                    break;
                }
            }
            if (record === undefined)
                return;
            record.merged = true;
            // A worker that never committed did nothing. Upstream still closes
            // such a task ("completed" with an empty summary), which would
            // silently drop the task from the result. The task is failed
            // instead, so the run retries it or blocks for a human.
            const commits = await git(record.facts.path, ['rev-list', '--count', `${runInfo.target}..${record.branch}`]);
            if (commits === '' || commits === '0') {
                console.log(`[swarm-worktree] task ${taskId} of ${runId}: worker committed nothing — task failed`);
                record.released = await releaseWorktree(record, runInfo.target);
                console.log(`[swarm-worktree] task ${taskId} of ${runId}: ${record.released}`);
                await failTask(swarm, runId, taskId);
                return;
            }
            const report = await mergeBranch(record, runInfo.target);
            console.log(`[swarm-worktree] task ${taskId} of ${runId}: ${report}`);
            if (record.released === undefined) {
                record.released = await releaseWorktree(record, runInfo.target);
                console.log(`[swarm-worktree] task ${taskId} of ${runId}: ${record.released}`);
            }
        };
    };

    const wireSwarmWhenReady = () => {
        const swarm = swarmService();
        if (swarm !== undefined) {
            wireSwarm(swarm);
            return;
        }
        // The swarm service is mounted in its own scope, so it is reached
        // through `ctx.inject`: the callback runs once the service exists.
        try {
            ctx.inject(['swarm'], (swarmCtx) => {
                const found = swarmCtx.get('swarm');
                console.log(`[swarm-worktree] swarm service via inject: ${found === undefined ? 'NOT found' : 'found'}`);
                if (found !== undefined)
                    wireSwarm(found);
            });
        }
        catch (error) {
            debug(`[swarm-worktree] inject(['swarm']) failed: ${String(error)}`);
        }
    };
    wireSwarmWhenReady();
}

#!/usr/bin/env node
/**
 * Reject whitespace defects in the staged changes, except in patch files.
 *
 * `git diff --cached --check` reads the diff marker of a patch-file line as a
 * space before the tab indentation it quotes, so it reports the upstream source
 * a patch carries. Every other staged path is checked by the stock command.
 */
import { execFileSync } from 'node:child_process'

/** Staged paths whose content quotes another file's source verbatim. */
const patchPath = /^ecosystem\/profiles\/[^/]+\/patches\/[^/]+\.patch$/u

function stagedPaths(): string[] {
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  })
  return output.split('\n').filter(line => line.length > 0)
}

function main(): void {
  const patches = stagedPaths().filter(path => patchPath.test(path))
  if (patches.length === 0) {
    execFileSync('git', ['diff', '--cached', '--check'], { stdio: 'inherit' })
    return
  }
  // The stock check sees the patch files' quoted source, so run it against a
  // tree without them: `git diff --cached --check` reads the index, and the
  // index is what it inspects, so the check runs on the other paths by name.
  const others = stagedPaths().filter(path => !patchPath.test(path))
  if (others.length === 0) return
  const output = execFileSync('git', ['diff', '--cached', '--check', '--', ...others], {
    encoding: 'utf8',
  })
  if (output.length > 0) {
    process.stdout.write(output)
    process.exit(1)
  }
}

main()

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, 'verify-staged-whitespace.ts')
const tsx = join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')

/** Run the check in a throwaway repository that stages the given files. */
function staged(files: Record<string, string>): { code: number; output: string } {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-staged-whitespace-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.name', 'check')
    git('config', 'user.email', 'check@local')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
      git('add', path)
    }
    try {
      const output = execFileSync('node', ['--import', tsx, script], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { code: 0, output }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

describe('staged whitespace check', () => {
  it('accepts a staged file without whitespace defects', () => {
    const result = staged({ 'notes.md': 'clean line\n' })
    expect(result.code).toBe(0)
  })

  it('rejects a staged file with trailing whitespace', () => {
    const result = staged({ 'notes.md': 'trailing space \n' })
    expect(result.code).not.toBe(0)
  })

  it('accepts a patch file that quotes tab-indented upstream source', () => {
    const result = staged({
      'ecosystem/profiles/ultracode/patches/plugin@1.0.0.patch':
        'diff --git a/lib/index.js b/lib/index.js\n--- a/lib/index.js\n+++ b/lib/index.js\n@@ -1,1 +1,1 @@\n+\t\tconst value = 1;\n',
    })
    expect(result.code).toBe(0)
  })
})

/** UC-022「資格対策の問題解説を配る前に教材の門で確かめる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止める場合と断る場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時ディレクトリに置き、そこを作業の場所にして教材の門の入口（checkExplanations）を呼ぶ。
 *  request は契約の例 pass と同じ data/ip（入力の束の置き場は省略）。門が読む入力の束・問題解説・過去問・正解表・用語の上書きは
 *  tests/fixtures/explanations-gate/ip の仕込み（問題解説 4 本）を、登録簿はリポジトリのものを写す。 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const SEED = join(REPO, 'tests/fixtures/explanations-gate/ip')
const REQUEST = { data: 'data/ip' }

type Finding = { kind: string; where: string; reason: string }
type GateResult = { exitCode: number; questions: number; stops: Finding[]; warnings: Finding[]; limits: Record<string, unknown> }

let root = ''

/** 作業の場所で教材の門の入口を呼び、終了の状態と標準出力の JSON（全体か最後の空でない行）を返す。 */
function checkExplanations(req: typeof REQUEST): { status: number | null; result: GateResult | null; out: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', 'check_explanations.py'), '--data', req.data], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  const stdout = p.stdout ?? ''
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  const read = (t: string) => {
    try {
      return JSON.parse(t) as GateResult
    } catch {
      return null
    }
  }
  return { status: p.status, result: read(stdout.trim()) ?? read(lines[lines.length - 1] ?? ''), out: `${stdout}${p.stderr ?? ''}` }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uc022-'))
  cpSync(SEED, join(root, REQUEST.data), { recursive: true })
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('UC-022 資格対策の問題解説を配る前に教材の門で確かめる', () => {
  // @scenario UC-022
  it('資格対策の学びの問題解説を教材の門にかけ、止める理由が無いので通った結果と見た問題の数と警告を受け取る', () => {
    const bundleDir = join(root, REQUEST.data, 'explanation_bundles')
    const inBundles = readdirSync(bundleDir).reduce(
      (n, f) => n + (JSON.parse(readFileSync(join(bundleDir, f), 'utf8')).topics as { questions: unknown[] }[]).reduce((m, t) => m + t.questions.length, 0),
      0,
    )

    // step 1: 作り手が、資格対策の学びの問題解説を教材の門にかける
    const gate = checkExplanations(REQUEST)
    const result = gate.result
    expect(result, `教材の門の結果が標準出力の JSON に無い: ${gate.out}`).not.toBeNull()
    if (!result) return

    // step 2〜3: システムが、どの問題にも問題解説が 1 つあること・必須の要素と過去問と正解表との一致・用語・原文の写しを確かめる
    //   （確かめた結果は止める理由の有無として step 5 で返る）
    expect(result.stops, `止める理由が当たった: ${JSON.stringify(result.stops)}`).toEqual([])

    // step 4: システムが、情報の量を見ずに、表示の制約と書き方を警告として挙げる
    expect(Array.isArray(result.warnings), '警告が結果に無い').toBe(true)

    // step 5: システムが、見た問題の数、警告、止める理由を返し、止める理由が無いので通す
    expect(result.questions, '見た問題の数が入力の束の問題の数と違う').toBe(inBundles)
    expect(result.exitCode, '止める理由が無いのに通していない').toBe(0)
    expect(gate.status, '通した結果と終了の状態が食い違う').toBe(0)

    // step 6: 作り手が、通ったことを見て、問題解説を投入に回す（投入はこの UC の境界の外）

    // 成功時: 「止める理由が無い」という門の結果と、見た問題の数と警告
    expect(result.questions, '見た問題が無い').toBeGreaterThan(0)
  }, 180_000)
})

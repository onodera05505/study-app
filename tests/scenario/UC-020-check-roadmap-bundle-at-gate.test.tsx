/** UC-020「書き手から上がったロードマップ型の束を教材の門で確かめる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止める場合と断る場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時ディレクトリに置き、そこを作業の場所にして教材の門の入口（checkRoadmapBundle）を呼ぶ。
 *  request は契約の例 pass と同じ data/itc・bundle_01。門が読む割り当て・教材・確認問題・ロードマップ・集めた資料は
 *  tests/fixtures/roadmap-bundle-gate/itc の仕込み（論点 2 つ・確認問題 4 問）を、登録簿はリポジトリのものを写す。 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const SEED = join(REPO, 'tests/fixtures/roadmap-bundle-gate/itc')
const REQUEST = { data: 'data/itc', bundle: 'bundle_01' }

type Finding = { kind: string; where: string; reason: string }
type GateResult = { exitCode: number; topics: number; questions: number; stops: Finding[]; warnings: Finding[]; limits: Record<string, unknown> }

let root = ''

/** 作業の場所で教材の門の入口を呼び、終了の状態と標準出力の最後の行（機械向けの 1 行）を返す。 */
function checkRoadmapBundle(req: typeof REQUEST): { status: number | null; result: GateResult | null; out: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', 'check_roadmap_bundle.py'), '--data', req.data, '--bundle', req.bundle], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  const lines = (p.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
  let result: GateResult | null = null
  try {
    result = JSON.parse(lines[lines.length - 1] ?? '') as GateResult
  } catch {
    result = null
  }
  return { status: p.status, result, out: `${p.stdout ?? ''}${p.stderr ?? ''}` }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uc020-'))
  cpSync(SEED, join(root, REQUEST.data), { recursive: true })
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('UC-020 書き手から上がったロードマップ型の束を教材の門で確かめる', () => {
  // @scenario UC-020
  it('書き手から上がった束を教材の門にかけ、止める理由が無いので通った結果と見た論点と問題の数と警告を受け取る', () => {
    const assigned = JSON.parse(readFileSync(join(root, REQUEST.data, 'material_bundles', `${REQUEST.bundle}.json`), 'utf8')).topics.length as number
    const questions = JSON.parse(readFileSync(join(root, REQUEST.data, 'roadmap_questions', `${REQUEST.bundle}.json`), 'utf8')).questions.length as number

    // step 1: 作り手が、書き手から上がった束を、学びと束の名前を指定して教材の門にかける
    const gate = checkRoadmapBundle(REQUEST)
    const result = gate.result
    expect(result, `教材の門の結果が標準出力の最後の行に無い: ${gate.out}`).not.toBeNull()
    if (!result) return

    // step 2〜4: システムが、論点と割り当ての一致・各教材の要素と記法と出典と用語と禁じた書き方・確認問題の形を確かめる
    //   （確かめた結果は止める理由の有無として step 6 で返る）
    expect(result.stops, `止める理由が当たった: ${JSON.stringify(result.stops)}`).toEqual([])

    // step 5: システムが、情報の量を見ずに、表示の制約と書き方と確認問題の手がかりを警告として挙げる
    expect(Array.isArray(result.warnings), '警告が結果に無い').toBe(true)

    // step 6: システムが、見た論点と問題の数、警告、止める理由を、人が読む行と末尾の機械向けの 1 行で返し、通す
    expect(result.topics, '見た論点の数が割り当ての論点の数と違う').toBe(assigned)
    expect(result.questions, '見た問題の数が束の確認問題の数と違う').toBe(questions)
    expect(result.exitCode, '止める理由が無いのに通していない').toBe(0)
    expect(gate.status, '通した結果と終了の状態が食い違う').toBe(0)

    // step 7: 作り手が、通ったことを見て、束を学び全体の門にかける順に回す（学び全体の門はこの UC の境界の外）

    // 成功時: 「止める理由が無い」という門の結果と、見た論点と問題の数と警告
    expect(result.topics, '見た論点が無い').toBeGreaterThan(0)
    expect(result.questions, '見た問題が無い').toBeGreaterThan(0)
  }, 180_000)
})

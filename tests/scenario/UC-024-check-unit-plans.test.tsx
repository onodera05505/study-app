/** UC-024「資格対策の単元の構成を教材の門で確かめる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止める場合と断る場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時ディレクトリに置き、そこを作業の場所にして教材の門の入口を呼ぶ。
 *  契約の data は作業の場所からの相対の道で、学びは登録簿にある資格対策の ip。
 *  門が読む単元の構成・シラバス・論点の一覧と登録簿は、今のデータをそのまま写したものを使う。 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const DATA = 'data/ip'

type Finding = { kind: string; where: string; reason: string }
type GateResult = {
  exitCode: number
  units: number
  topics: number
  stops: Finding[]
  warnings: Finding[]
  limits: { groupTopicsMax: number; groupTopicsMinWarn: number; prerequisitesMax: number }
}
type UnitPlan = { groups: { topics: number[] }[] }

let root = ''

/** 作業の場所で教材の門の入口を呼び、終了コードと標準出力の JSON を返す。 */
function checkUnitPlans(data: string): { status: number | null; json: unknown; stderr: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', 'check_unit_plans.py'), '--data', data], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  let json: unknown = null
  try {
    json = JSON.parse(p.stdout)
  } catch {
    json = null
  }
  return { status: p.status, json, stderr: `${p.stderr ?? ''}${p.error ? String(p.error) : ''}` }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uc024-'))
  mkdirSync(join(root, DATA), { recursive: true })
  for (const f of ['unit_plans', 'syllabus.json', 'topics.json']) {
    cpSync(join(REPO, DATA, f), join(root, DATA, f), { recursive: true })
  }
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('UC-024 資格対策の単元の構成を教材の門で確かめる', () => {
  // @scenario UC-024
  it('資格対策の学びの単元の構成を教材の門にかけ、止める理由が無いので通った結果と見た数と警告を受け取る', () => {
    const planDir = join(root, DATA, 'unit_plans')
    const plans = readdirSync(planDir)
      .filter((n) => /^[0-9]{2}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(planDir, n), 'utf8')) as UnitPlan)
    const topicCount = plans.reduce((sum, p) => sum + p.groups.reduce((s, g) => s + g.topics.length, 0), 0)

    // step 1: 作り手が、資格対策の学びの単元の構成を教材の門にかける
    const gate = checkUnitPlans(DATA)
    const result = gate.json as GateResult
    expect(result, `教材の門の結果が標準出力の JSON に無い: ${gate.stderr}`).not.toBeNull()

    // step 2〜4: システムが、必須の要素とシラバスの単元・まとまりの論点と上限・受け持ちと前提と学ぶ順を確かめる
    //   （確かめた結果は止める理由の有無として step 5 で返る）
    expect(result.stops, `止める理由が当たった: ${JSON.stringify(result.stops)}`).toEqual([])

    // step 5: システムが、見た単元と論点の数、警告、止める理由を返し、止める理由が無いので通す
    expect(result.units, '見た単元の数が単元の構成の数と違う').toBe(plans.length)
    expect(result.topics, '見た論点の数が単元の構成にある論点の数と違う').toBe(topicCount)
    expect(Array.isArray(result.warnings), '警告が結果に無い').toBe(true)
    for (const w of result.warnings) {
      expect(w.kind, '警告でない種類が警告に入っている').toBe('groupTooSmall')
      expect(w.where.length, '警告の箇所が無い').toBeGreaterThan(0)
      expect(w.reason.length, '警告の理由が無い').toBeGreaterThan(0)
    }

    // step 6: 作り手が、通ったことを見る（書き直しの束を作るのはこの UC の境界の外）
    expect(result.exitCode, '止める理由が無いのに通していない').toBe(0)
    expect(gate.status, '通した結果と終了コードが食い違う').toBe(0)

    // 成功時: 「止める理由が無い」という門の結果と、見た単元と論点の数と警告
    expect(result.units, '資格対策の学びなのに単元の構成を 1 つも見ていない').toBeGreaterThan(0)
    expect(result.topics, '見た論点が無い').toBeGreaterThan(0)
  }, 180_000)
})

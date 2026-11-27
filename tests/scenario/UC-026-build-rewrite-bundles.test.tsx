/** UC-026「資格対策の教材の書き直しに配る束を単元とまとまりの単位で作る」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止まる場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時ディレクトリに置き、そこを作業の場所にしてコマンドを呼ぶ。
 *  契約の data・out は作業の場所からの相対の道で、学びは登録簿にある資格対策の ip。
 *  学びの置き場は ip の今のデータ（原本の PDF とページの画像を除く）を写したものを使い、
 *  単元の構成は作業の場所から一度外し、書き手が書いた物として ip の今の単元の構成を置き直す。 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const DATA = 'data/ip'
const UNIT_INPUTS_OUT = 'bundles/unit_inputs'
const REWRITE_OUT = 'bundles/rewrite'
/** 束づくりに関わらない大きな原本（PDF とページの画像）は写さない。 */
const SKIP = new Set(['pdfs', 'pages'])

type Plan = { unit_no: number; groups: { name: string; topics: number[] }[] }

let root = ''

/** 作業の場所でコマンドを呼び、終了コードと標準出力の JSON を返す。
 *  標準出力に人が読む行が先に出ることがあるので、最初の「{」で始まる行から後を JSON として読む。 */
function run(script: string, args: string[]): { status: number | null; json: any; out: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  const stdout = p.stdout ?? ''
  let json: any = null
  const start = stdout.search(/^\{/m)
  if (start >= 0) {
    try {
      json = JSON.parse(stdout.slice(start))
    } catch {
      json = null
    }
  }
  return { status: p.status, json, out: `${stdout}${p.stderr ?? ''}${p.error ? String(p.error) : ''}` }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 論点のある単元ごとの論点の番号（単元はシラバスの小項目が属する単元の番号）。 */
function topicsByUnit(): Map<number, Set<number>> {
  const syllabus = readJson(join(root, DATA, 'syllabus.json'))
  const unitOfItem = new Map<number, number>(syllabus.items.map((i: any) => [i.number, i.middle_no]))
  const byUnit = new Map<number, Set<number>>()
  for (const t of readJson(join(root, DATA, 'topics.json')).topics) {
    const unit = unitOfItem.get(t.syllabus_item)!
    if (!byUnit.has(unit)) byUnit.set(unit, new Set())
    byUnit.get(unit)!.add(t.id)
  }
  return byUnit
}

const pad = (n: number) => String(n).padStart(2, '0')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uc026-'))
  cpSync(join(REPO, DATA), join(root, DATA), {
    recursive: true,
    filter: (src) => !SKIP.has(src.slice(join(REPO, DATA).length + 1).split('/')[0]),
  })
  // 単元の構成は主シナリオの手順 3 で書き手が書くので、作業の場所から外しておく
  rmSync(join(root, DATA, 'unit_plans'), { recursive: true, force: true })
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('UC-026 資格対策の教材の書き直しに配る束を単元とまとまりの単位で作る', () => {
  // @scenario UC-026
  it('単元の入力の束を作り、門を通した単元の構成から書き直しの束を作って、その数を書き手の割り当てに使う', () => {
    const byUnit = topicsByUnit()
    const units = [...byUnit.keys()].sort((a, b) => a - b)
    expect(units.length, '論点のある単元が無い').toBeGreaterThan(0)

    // step 1: 作り手が、単元の入力の束を作る
    const inputs = run('build_rewrite_bundles.py', ['--data', DATA, '--out', UNIT_INPUTS_OUT, '--unit-inputs'])
    expect(inputs.status, `単元の入力の束を作れなかった: ${inputs.out}`).toBe(0)
    expect(inputs.json?.exitCode).toBe(0)

    // step 2: システムが、単元ごとに 1 つ、その単元の全論点と今の教材を持つ単元の入力の束を書き出す
    expect([...inputs.json.written].sort(), '論点のある単元ごとに 1 つの単元の入力の束になっていない').toEqual(
      units.map((u) => `${UNIT_INPUTS_OUT}/${pad(u)}.json`),
    )
    for (const u of units) {
      const bundle = readJson(join(root, UNIT_INPUTS_OUT, `${pad(u)}.json`))
      expect(bundle.unit_no).toBe(u)
      expect(new Set(bundle.topics.map((t: any) => t.topic_id)), `単元 ${u} の束が単元の全論点を持たない`).toEqual(byUnit.get(u))
      for (const t of bundle.topics) expect(t.explanation, `論点 ${t.topic_id} の今の教材が束に無い`).not.toBe('')
    }

    // step 3: 作り手が、単元の構成を書き手に書かせ（ip の今の単元の構成で置き換える）、教材の門を通してから、書き直しの束を作る
    cpSync(join(REPO, DATA, 'unit_plans'), join(root, DATA, 'unit_plans'), { recursive: true })
    const gate = run('check_unit_plans.py', ['--data', DATA])
    expect(gate.status, `単元の構成が教材の門を通らなかった: ${gate.out}`).toBe(0)
    expect(gate.json?.stops, '教材の門に止める理由がある').toEqual([])
    const rewrite = run('build_rewrite_bundles.py', ['--data', DATA, '--out', REWRITE_OUT])

    // step 4: システムが、単元の構成が教材の門の止める理由に当たらないことを確かめる
    expect(rewrite.status, `書き直しの束を作れなかった: ${rewrite.out}`).toBe(0)
    expect(rewrite.json?.exitCode).toBe(0)

    // step 5: システムが、まとまりごとに 1 つ、学ぶ順の論点と今の教材・過去問・問題解説・図の仕様・前提と受け持ちを持つ書き直しの束を書き出す
    const plans = new Map<number, Plan>(units.map((u) => [u, readJson(join(root, DATA, 'unit_plans', `${pad(u)}.json`)) as Plan]))
    const expected = units.flatMap((u) => plans.get(u)!.groups.map((_, i) => `${REWRITE_OUT}/${pad(u)}-${i + 1}.json`))
    expect([...rewrite.json.written].sort(), 'まとまりごとに 1 つの書き直しの束になっていない').toEqual([...expected].sort())
    for (const u of units) {
      plans.get(u)!.groups.forEach((group, i) => {
        const bundle = readJson(join(root, REWRITE_OUT, `${pad(u)}-${i + 1}.json`))
        expect(bundle.unit_no).toBe(u)
        expect(bundle.topics.map((t: any) => t.topic_id), `${pad(u)}-${i + 1} の論点が学ぶ順でない`).toEqual(group.topics)
        expect(Array.isArray(bundle.owners), `${pad(u)}-${i + 1} に受け持ちが無い`).toBe(true)
        for (const t of bundle.topics) {
          expect(t.current, `論点 ${t.topic_id} の今の教材が束に無い`).toBeTruthy()
          expect(Array.isArray(t.questions), `論点 ${t.topic_id} の過去問が束に無い`).toBe(true)
          expect(Array.isArray(t.question_explanations), `論点 ${t.topic_id} の問題解説が束に無い`).toBe(true)
          expect(Array.isArray(t.figures), `論点 ${t.topic_id} の図の仕様が束に無い`).toBe(true)
          expect(Array.isArray(t.prerequisites), `論点 ${t.topic_id} の前提の論点が束に無い`).toBe(true)
        }
      })
    }

    // step 6 / 成功時: 作り手が、出力先の束の数が単元またはまとまりの数と同じであることを見て、束ごとに書き手を割り当てる
    const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.json'))
    expect(files(UNIT_INPUTS_OUT).length, '単元の入力の束の数が論点のある単元の数と違う').toBe(units.length)
    expect(files(REWRITE_OUT).length, '書き直しの束の数がまとまりの数と違う').toBe(expected.length)
    for (const p of [...inputs.json.written, ...rewrite.json.written]) {
      expect(existsSync(join(root, p)), `書き手に割り当てる束 ${p} が出力先に無い`).toBe(true)
    }
  }, 180_000)
})

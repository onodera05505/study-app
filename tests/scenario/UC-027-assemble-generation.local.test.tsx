/** UC-027「書き直した世代の教材と単元の構成を配る本文に組み立てる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。止まる場合・置けない図は各要件のテストが見る）。
 *
 *  作り手の手元を一時の作業場に置き、そこを作業の場所にして契約の入口（attachMaterialFigures・buildSeed・checkRender）を
 *  コマンドとして呼ぶ。学びは登録簿にある資格対策の学びの ip で、学びの置き場（PDF とページの画像を除く）・図の画像・
 *  書き直した世代・単元の構成は、ip の今のデータをそのまま写したものを使う。
 *  配る本文がどの世代から来たかを見分けるため、写しの教材の本文の先頭に世代ごとの目印を置く（手順ではなく仕込み）。
 *  組み立てた投入は migrations を当てた SQLite に流し、配る本文を getTopicDetail の境界で見る。 */

import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Json,
  type Run,
  type Ws,
  PREVIOUS,
  REWRITTEN,
  ROOT,
  SEED,
  attachFigures,
  buildSeed,
  checkRender,
  entriesOf,
  figureSpec,
  isFigure,
  loadSeed,
  mark,
  placement,
  prependMark,
  resultOf,
  rows,
  topicDetail,
} from '../server/UC-027_fixture.local'

const LEARNING = 'ip'

let ws: Ws

/** 学びの置き場を書き直した世代・単元の構成ごと写した作業場（UC-027 の事前条件のとおり）。 */
function workspaceWithRewritten(learning: string): Ws {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc027-scenario-'))
  const src = path.join(ROOT, 'data', learning)
  const skip = new Set([path.join(src, 'pdfs'), path.join(src, 'pages')])
  fs.cpSync(src, path.join(dir, 'data', learning), { recursive: true, filter: (s) => !skip.has(s) })
  for (const sub of [learning, path.join('materials', learning)]) {
    const f = path.join(ROOT, 'public', 'figures', sub)
    if (fs.existsSync(f)) fs.cpSync(f, path.join(dir, 'public', 'figures', sub), { recursive: true })
  }
  const abs = (rel: string) => path.join(dir, rel)
  return {
    dir,
    learning,
    data: `data/${learning}`,
    abs,
    readJson: (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8')),
    readText: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    writeJson: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), JSON.stringify(v, null, 2))
    },
    writeText: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), v)
    },
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
  }
}

/** 世代の置き場にある教材の論点 ID。 */
function topicIdsOf(gen: string): Set<number> {
  const dir = ws.abs(`${ws.data}/${gen}`)
  const ids = new Set<number>()
  if (!fs.existsSync(dir)) return ids
  for (const n of fs.readdirSync(dir).filter((n) => n.endsWith('.json')))
    for (const m of ws.readJson(`${ws.data}/${gen}/${n}`).materials as Json[]) ids.add(m.topic_id)
  return ids
}

const ok = (r: Run, label: string): Json => {
  expect(r.status, `${label} が終了 0 で終わらなかった:\n${r.out}`).toBe(0)
  const res = resultOf(r)
  expect(res, `${label} の結果が標準出力の JSON に無い:\n${r.out}`).not.toBeNull()
  return res!
}

beforeEach(() => {
  ws = workspaceWithRewritten(LEARNING)
})

afterEach(() => {
  fs.rmSync(ws.dir, { recursive: true, force: true })
})

describe('UC-027 書き直した世代の教材と単元の構成を配る本文に組み立てる', () => {
  // @scenario UC-027
  it('書き直した世代に図を差し込み、単元の構成と一緒に投入へ組み立て、実データの描画の検査が通る', async () => {
    // 事前条件: 書き直した世代と単元の構成が学びの置き場にある
    const rewritten = topicIdsOf(REWRITTEN)
    expect(rewritten.size, '書き直した世代の教材が学びの置き場に無い').toBeGreaterThan(0)
    const planDir = ws.abs(`${ws.data}/unit_plans`)
    const plans = fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((n) => n.endsWith('.json')) : []
    expect(plans.length, '単元の構成が学びの置き場に無い').toBeGreaterThan(0)

    // 論点ごとに選ばれるはずの世代（最も新しい世代）と、世代ごとの目印
    const gens = [...PREVIOUS, REWRITTEN]
    const idsByGen = new Map(gens.map((g) => [g, topicIdsOf(g)]))
    const chosen = new Map<number, string>()
    for (const g of gens) for (const id of idsByGen.get(g)!) chosen.set(id, g)
    const expectedCounts: Record<string, number> = {}
    for (const g of chosen.values()) expectedCounts[g] = (expectedCounts[g] ?? 0) + 1
    for (const g of gens) for (const id of idsByGen.get(g)!) prependMark(ws, g, id)

    // step 1: 作り手が、書き直した世代の教材に図を差し込む
    const attached = ok(attachFigures(ws), '図の差し込み')

    // step 2: システムが、配る本文と同じ選び方で世代を選び、書き直した世代から選んだ論点の図を差し込み位置に入れる
    expect(attached.problems, '差し込まなかった図がある').toEqual([])
    expect(attached.topicsByGeneration, '図の差し込みの世代の選び方が配る本文の選び方と違う').toEqual(expectedCounts)
    expect(attached.figures, '図が 1 枚も差し込まれていない').toBeGreaterThan(0)

    // step 3: 作り手が、投入を組み立てる
    // step 4: システムが、単元の構成が教材の門の止める理由に当たらないことを確かめる
    // step 5: システムが、書き直した世代を最も新しい世代として配る本文を選び、単元の構成と一緒に投入に組み立てる
    const built = ok(buildSeed(ws), '投入の組み立て')
    expect(built.exitCode).toBe(0)
    expect(built.output, '投入の書き出し先が学びの置き場の投入でない').toBe(SEED(ws))
    expect(fs.existsSync(ws.abs(built.output)), '投入が書き出されていない').toBe(true)
    expect(built.topicsByGeneration, '投入の世代の選び方が図の差し込みの選び方と違う').toEqual(expectedCounts)
    expect(built.units, '単元の構成が投入に含まれていない').toBe(plans.length)

    // step 6: 作り手が、実データの描画の検査をかける
    // step 7: システムが、配る本文と同じ選び方で選んだ教材を描き、決めた記法だけが解釈されていることを確かめる
    const rendered = ok(checkRender(ws), '実データの描画の検査')

    // step 8: 作り手が、検査が通ったことを見て、配備に回す
    expect(rendered.exitCode, '実データの描画の検査が通っていない').toBe(0)
    expect(rendered.topicsByGeneration, '描画の検査の世代の選び方が配る本文の選び方と違う').toEqual(expectedCounts)
    expect(rendered.topics, '描画の検査が選んだ教材の全件を描いていない').toBe(chosen.size)

    // 成功時: 投入を流した配る本文が、書き直した世代の論点は書き直した教材と差し込み位置どおりの図で、他の論点は前の世代のまま
    const d1 = await loadSeed(ws.readText(built.output))
    for (const [id, gen] of chosen) {
      const topic = await topicDetail(d1, LEARNING, id)
      const body = `${topic.explanation ?? ''}\n${topic.detail ?? ''}`
      expect(body, `論点 ${id} の配る本文が ${gen} から選ばれていない`).toContain(mark(gen, id))
      for (const other of gens.filter((g) => g !== gen && idsByGen.get(g)!.has(id)))
        expect(body, `論点 ${id} の配る本文に ${other} が混ざっている`).not.toContain(mark(other, id))
      if (gen !== REWRITTEN) continue
      const placed = placement({ explanation: topic.explanation, detail: topic.detail })
      for (const fig of (figureSpec(ws, id)?.figures ?? []) as Json[]) {
        const where = fig.after === 'explanation' ? 'explanation' : String(fig.after).trim()
        expect(
          placed.some(([section, p]) => section === where && isFigure(p, id, fig.id)),
          `論点 ${id} 図 ${fig.id} が差し込み位置 ${where} に無い`,
        ).toBe(true)
      }
      expect(entriesOf(ws, REWRITTEN, id).length, `論点 ${id} の書き直した教材が置き場から消えている`).toBeGreaterThan(0)
    }

    // 成功時: 単元の構成が投入と一緒に入っている
    expect(rows(d1, 'SELECT COUNT(*) AS n FROM unit_plans')[0].n, '流した DB に単元の構成がそろっていない').toBe(plans.length)
  }, 600_000)
})

/** UC-030「ロードマップ型の学びのロードマップと投入データを論点の候補から組み立てる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。止まる場合・警告・引数の決め方は各要件のテストが見る）。
 *
 *  作り手の手元を一時の作業場に置き、そこを作業の場所にして契約の入口（buildRoadmap・applySummaryOverride・buildTargetDataset）を
 *  コマンドとして呼ぶ。学びは登録簿にある日で束ねる学びの itc で、学びの置き場と教材の図は itc の今のデータを写したものを使う。
 *  仕込み（手順ではない）:
 *  - 書き手の教材の束がまだ無い学びとして始めるため、教材の束・確認問題の束・束の割り当てを写しから外しておき、
 *    投入データを組み立てる前（事前条件「教材と確認問題がそろっている」）に写しの束を戻す
 *  - 名前と副題を分けたまま運ばれることと落とした候補を見分けるため、候補の 1 つに副題を書き足し、到達基準を持たない候補を 1 つ足す */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APPLY_SUMMARY,
  BUILD_DATASET,
  BUILD_ROADMAP,
  type Json,
  type Run,
  ROOT,
  cleanup,
  readJson,
  registry,
  run,
  workspace,
  writeJson,
} from '../server/UC-030_roadmap_fixture'

const LEARNING = 'itc'
const DATA = `data/${LEARNING}`
/** 作り手が書く束（書き手の教材の束・確認問題の束）と、組み立て直しが書く束の割り当て。 */
const WRITER_BUNDLES = ['materials', 'roadmap_questions']
const ASSIGNMENT = 'material_bundles'
const SUBTITLE = '仕込みの副題'
const DROPPED_ID = 9101
const DROPPED_TERM = '仕込みの到達基準に繋がらない候補'
const NEW_SUMMARY = '作り手が差し替えた新しい要約'

afterEach(cleanup)

const ok = (r: Run, label: string) => expect(r.status, `${label} が終了 0 で終わらなかった:\n${r.out}`).toBe(0)

describe('UC-030 ロードマップ型の学びのロードマップと投入データを論点の候補から組み立てる', () => {
  // @scenario UC-030
  it('論点の候補からロードマップのデータを組み立て直し、要約を差し替え、教材と確認問題から投入データを組み立てる', () => {
    const ws = workspace('uc030-scenario')
    const dir = path.join(ws, DATA)
    const held = path.join(ws, 'held')
    fs.cpSync(path.join(ROOT, DATA), dir, { recursive: true })
    const figures = path.join(ROOT, 'public', 'figures', 'materials', LEARNING)
    if (fs.existsSync(figures)) fs.cpSync(figures, path.join(ws, 'public', 'figures', 'materials', LEARNING), { recursive: true })
    const at = (rel: string) => path.join(dir, rel)
    const spec = registry(LEARNING).roadmapSpec as Json

    // 事前条件: 論点の候補とロードマップの設定が学びの置き場にある
    expect(fs.existsSync(at('topics_candidates.json')), '論点の候補が学びの置き場に無い').toBe(true)
    expect(fs.existsSync(at('roadmap_config.json')), 'ロードマップの設定が学びの置き場に無い').toBe(true)

    // 仕込み: 今のロードマップの先頭の単位の候補に副題を足し、到達基準を持たない候補を足す
    const firstUnit = (readJson(at('roadmap.json')).units as Json[]).find((u) => u.order === 1)!
    const cands = readJson(at('topics_candidates.json'))
    const withSubtitle = (cands.candidates as Json[]).find((c) => c.id === firstUnit.topic_id)!
    withSubtitle.subtitle = SUBTITLE
    const template = (cands.candidates as Json[])[0]
    cands.candidates.push({ ...template, id: DROPPED_ID, term: DROPPED_TERM, prereq: [], goals: [], aliases: [] })
    writeJson(at('topics_candidates.json'), cands)
    // 仕込み: 書き手の教材の束がまだ無い学びにする（束は脇に置き、後で戻す）。前の組み立ての書き出しも外す
    fs.mkdirSync(held, { recursive: true })
    for (const sub of WRITER_BUNDLES) fs.renameSync(at(sub), path.join(held, sub))
    for (const rel of [ASSIGNMENT, 'roadmap.json', 'topics.json', 'questions'])
      fs.rmSync(at(rel), { recursive: true, force: true })

    // step 1: 作り手が、論点の候補とロードマップの設定から、ロードマップのデータを組み立て直す
    const rebuilt = run(ws, BUILD_ROADMAP, ['--data', DATA])
    // step 2: システムが、設定の回の束ね方・設定が指す論点の ID・候補の名前を確かめる
    ok(rebuilt, 'ロードマップのデータの組み立て直し')

    // step 3: システムが、単位を選んで学ぶ順に並べ、名前と副題を分けたまま書き出し、到達基準に繋がらない候補を落とした候補として残す
    const roadmap = readJson(at('roadmap.json'))
    const units = roadmap.units as Json[]
    expect(units.length, 'ロードマップのデータに単位が無い').toBeGreaterThan(0)
    expect(
      units.map((u) => u.order).sort((a, b) => a - b),
      '学ぶ順が 1 から欠番なく並んでいない',
    ).toEqual(units.map((_, i) => i + 1))
    const subtitled = units.find((u) => u.topic_id === withSubtitle.id)
    expect(subtitled, '副題を足した候補が単位になっていない').toBeDefined()
    expect(subtitled!.term, '単位の名前が候補の名前のままでない').toBe(withSubtitle.term)
    expect(subtitled!.subtitle, '単位の副題が候補の副題のままでない').toBe(SUBTITLE)
    expect(units.map((u) => u.topic_id), '到達基準を持たない候補が単位になっている').not.toContain(DROPPED_ID)
    const { units: _u, ...outside } = roadmap
    expect(JSON.stringify(outside), '到達基準を持たない候補が落とした候補として残っていない').toContain(DROPPED_TERM)

    // step 4: システムが、書き手の教材の束がまだ無いので、書き手への束の割り当ても書き出す
    const assigned = fs.existsSync(at(ASSIGNMENT))
      ? fs
          .readdirSync(at(ASSIGNMENT))
          .filter((n) => n.endsWith('.json'))
          .flatMap((n) => readJson(at(`${ASSIGNMENT}/${n}`)).topics as Json[])
      : []
    expect(assigned.length, '書き手への束の割り当てが書き出されていない').toBeGreaterThan(0)
    const unitIds = new Set(units.map((u) => u.topic_id))
    for (const t of assigned) expect(unitIds.has(t.topic_id), `割り当ての論点 ${t.topic_id} が単位に無い`).toBe(true)

    // step 5: 作り手が、単位の論点の ID と新しい要約を渡して、要約を差し替える
    const target = units.find((u) => u.order === 2)!
    const replaced = run(ws, APPLY_SUMMARY, ['--data', DATA, '--id', String(target.topic_id), '--summary', NEW_SUMMARY])
    ok(replaced, '要約の差し替え')

    // step 6: システムが、ロードマップの設定の要約の差し替えと、ロードマップのデータのその単位の要約を同じ値に書き換える
    expect(readJson(at('roadmap_config.json')).summary_override[String(target.topic_id)]).toBe(NEW_SUMMARY)
    const afterReplace = readJson(at('roadmap.json')).units as Json[]
    expect(afterReplace.find((u) => u.topic_id === target.topic_id)!.summary).toBe(NEW_SUMMARY)

    // 事前条件（投入データの組み立て）: ロードマップの単位の教材と確認問題が学びの置き場にある
    for (const sub of WRITER_BUNDLES) fs.renameSync(path.join(held, sub), at(sub))

    // step 7: 作り手が、教材と確認問題がそろった学びの投入データを組み立てる
    const dataset = run(ws, BUILD_DATASET, ['--data', DATA])
    // step 8: システムが、各単位の教材と確認問題の数と印と副題の欄を確かめる
    // step 10: 作り手が、組み立てが止まらずに投入データが書き出されたことを見る
    ok(dataset, '投入データの組み立て')
    expect(fs.existsSync(at('topics.json')), '投入データが書き出されていない').toBe(true)

    // step 9 と成功時: 各単位の名前と副題が分かれたまま入り、ロードマップに無い論点の教材が補足の論点として学ぶ順の末尾にある
    const topics = readJson(at('topics.json')).topics as Json[]
    const topicOf = (id: number) => topics.find((t) => t.id === id)
    for (const u of afterReplace) expect(topicOf(u.topic_id), `単位 ${u.term} が投入データに無い`).toBeDefined()
    expect(topicOf(withSubtitle.id)!.term, '投入データの名前が単位の名前のままでない').toBe(withSubtitle.term)
    expect(topicOf(withSubtitle.id)!.subtitle, '投入データの副題が単位の副題のままでない').toBe(SUBTITLE)
    const materialIds = new Set(
      fs
        .readdirSync(at('materials'))
        .filter((n) => n.endsWith('.json'))
        .flatMap((n) => (readJson(at(`materials/${n}`)).materials as Json[]).map((m) => m.topic_id as number)),
    )
    const extras = [...materialIds].filter((id) => !unitIds.has(id))
    const last = Math.max(...afterReplace.map((u) => topicOf(u.topic_id)!.sort_order as number))
    for (const id of extras) {
      const t = topicOf(id)
      expect(t, `ロードマップに無い論点 ${id} の教材が投入データに無い`).toBeDefined()
      expect(t!.field, `論点 ${id} が補足の分野に無い`).toBe(spec.extraField)
      expect(t!.sort_order, `論点 ${id} が学ぶ順の末尾に無い`).toBeGreaterThan(last)
    }
  }, 600_000)
})

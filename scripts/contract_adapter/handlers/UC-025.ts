/**
 * UC-025 の受け持ち（様式の門 checkMaterialStyle ＝ `python3 scripts/check_material_style.py --data <学びの置き場> [--dir <世代>]`）。
 * 前提は実例の名前ごとに影の根へ作る（kit/tb.ts）。本文は重ならない漢字の並びで作り、数値と問われ方の言い回しは
 * その実例が名指す所にだけ置く。書き直した世代の束の名前は「単元の番号 2 桁-まとまりの順」。
 * - pass（ip, materials_v4）: 単元 21 に論点 201〜232。まとまりは 4 つ（学ぶ順に 209〜216・201〜208・217〜224・225〜232）で、
 *   束 21-1〜21-4 に同じ論点。前の世代 materials_v3 には論点 201 だけがあり、その短い説明に 80 がある（書き直した世代には無い）
 * - passWithoutRewrittenGeneration（fe, dir 省略）: シラバスと論点の一覧はあり、書き直した世代の置き場が無い
 * - stopped（ap, materials_v4）: 単元 5 に論点 101〜108 のまとまり 1 つと束 05-1。論点 105 の図の仕様に短い説明の直後の図が 2 枚あり、
 *   論点 105 の短い説明に「試験では」がある
 * - notRewrittenGeneration（ip, materials_v3）: pass と同じ学び
 * - unknownLearning（zzz）・notQualification（itc）・notQualificationBeforeNotRewrittenGeneration（itc, materials_v3）: pass と同じ形の学び
 * - syllabusMissing（fe）: 論点の一覧はあり、シラバスが無い
 * - syllabusUnreadable（ap）: シラバスが JSON として読めない
 */

import { defineHandler, Unanswerable } from '../kit/protocol'
import {
  answerOf, chunk, field, inShadow, kanjiSource, keyOf, planOf, range, removeFile, runScript, writeJson, writeLearning, writePlan,
  type SyllabusUnit, type TopicSeed,
} from '../kit/tb'
import type { Shadow } from '../kit/tool'

type Material = { topic_id: number; term: string; explanation: string; detail: string }

/** 書き直した世代の名前（契約の実例が書き直した世代とする物）。 */
const REWRITTEN = 'materials_v4'
/** その前の世代。 */
const PREVIOUS = 'materials_v3'

const UNIT_21: SyllabusUnit = { no: 21, name: '単元二十一', items: [54] }
const UNIT_5: SyllabusUnit = { no: 5, name: '単元五', items: [12] }

/** 書き直した世代の教材 1 つ（短い説明・詳しい解説・混同しやすい用語の見出し）。extra は短い説明の末尾に足す文。 */
function material(fresh: (n: number) => string, t: TopicSeed, extra = ''): Material {
  return {
    topic_id: t.id,
    term: t.term,
    explanation: `**${t.term}**とは、${fresh(12)}です。${extra}\n- **キーワード**: ${fresh(3)}\n\n- ${fresh(14)}です。`,
    detail: `### ${fresh(6)}\n${fresh(24)}です。\n### 混同しやすい用語\n- **${fresh(3)}** — ${fresh(12)}です。`,
  }
}

/** 単元 21 に論点 201〜232 を持ち、書き直した世代と前の世代を持つ学び（pass）。 */
async function ipRewritten(shadow: Shadow, key: string) {
  const fresh = kanjiSource()
  const topics: TopicSeed[] = range(201, 32).map((id) => ({ id, term: fresh(3), item: 54 }))
  await writeLearning(shadow, key, { units: [UNIT_21], topics })
  const groups = chunk([...range(209, 8), ...range(201, 8), ...range(217, 16)], [8, 8, 8, 8])
  await writePlan(shadow, key, planOf(UNIT_21, groups))
  for (const [i, ids] of groups.entries()) {
    const bundle = `21-${i + 1}`
    await writeJson(shadow, `data/${key}/${REWRITTEN}/${bundle}.json`, { bundle, materials: ids.map((id) => material(fresh, topics.find((t) => t.id === id)!)) })
  }
  const t201 = topics.find((t) => t.id === 201)!
  await writeJson(shadow, `data/${key}/${PREVIOUS}/expl_01.json`, {
    bundle: 'expl_01',
    materials: [{ topic_id: 201, term: t201.term, explanation: `**${t201.term}**とは、${fresh(6)}80${fresh(6)}です。`, detail: `### ${fresh(6)}\n${fresh(24)}です。` }],
  })
}

/** 単元 5 に論点 101〜108 を持ち、論点 105 が図の上限を超え問われ方の言い回しを持つ学び（stopped）。 */
async function apStopped(shadow: Shadow, key: string) {
  const fresh = kanjiSource()
  const topics: TopicSeed[] = range(101, 8).map((id) => ({ id, term: fresh(3), item: 12 }))
  await writeLearning(shadow, key, { units: [UNIT_5], topics })
  await writePlan(shadow, key, planOf(UNIT_5, [range(101, 8)]))
  const materials = topics.map((t) => material(fresh, t, t.id === 105 ? `試験では${fresh(8)}です。` : ''))
  await writeJson(shadow, `data/${key}/${REWRITTEN}/05-1.json`, { bundle: '05-1', materials })
  const t105 = topics.find((t) => t.id === 105)!
  await writeJson(shadow, `data/${key}/material_figures/105.json`, {
    topic_id: 105,
    term: t105.term,
    figures: [1, 2].map((id) => ({ id, type: 'blocks', caption: `${fresh(14)}を表します。`, after: 'explanation', nodes: [], edges: [] })),
  })
}

/** シラバスと論点の一覧だけを持つ学び。 */
async function bareLearning(shadow: Shadow, key: string) {
  const fresh = kanjiSource()
  await writeLearning(shadow, key, { units: [UNIT_21], topics: range(201, 5).map((id) => ({ id, term: fresh(3), item: 54 })) })
}

const PRECONDITIONS: Record<string, (shadow: Shadow, key: string) => Promise<void>> = {
  pass: ipRewritten,
  passWithoutRewrittenGeneration: bareLearning,
  stopped: apStopped,
  unknownLearning: ipRewritten,
  notQualification: ipRewritten,
  notRewrittenGeneration: ipRewritten,
  notQualificationBeforeNotRewrittenGeneration: ipRewritten,
  syllabusMissing: async (shadow, key) => {
    await bareLearning(shadow, key)
    await removeFile(shadow, `data/${key}/syllabus.json`)
  },
  syllabusUnreadable: async (shadow, key) => {
    await bareLearning(shadow, key)
    await shadow.write(`data/${key}/syllabus.json`, '{"items": [')
  },
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-025',
  parallel: true,
  operations: {
    checkMaterialStyle: async (line) => {
      const prepare = PRECONDITIONS[line.case]
      if (!prepare) throw new Unanswerable(`UC-025 checkMaterialStyle の例 ${line.case} の前提を知らない`)
      const key = keyOf(line.request)
      const dir = field(line.request, 'dir')
      return inShadow(async (shadow) => {
        await prepare(shadow, key)
        const args = ['--data', `data/${key}`, ...(dir === undefined ? [] : ['--dir', dir])]
        return answerOf(await runScript(shadow, 'check_material_style.py', args), [0, 1])
      })
    },
  },
})

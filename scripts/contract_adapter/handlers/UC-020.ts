/**
 * UC-020 の受け持ち（書き手の束の門 checkRoadmapBundle ＝ `python3 scripts/check_roadmap_bundle.py --data <学びの置き場> --bundle <束の名前>`）。
 * 引数は request の各欄と同じ名前（kit/td.ts の argsOf）。道具は実例ごとの影の根（登録簿だけを写す。kit/tb.ts の inShadow）を
 * 作業ディレクトリにして回す。応答は標準出力の最後の行の JSON（kit/td.ts の answerOf。止める理由ありの 1 も応答）。
 *
 * 前提（例の名前と契約の errors の when から）:
 * - pass（itc の bundle_01）: ロードマップの論点 8 つを束 bundle_01 に割り当て、教材 8 つと確認問題 16 問（論点ごとに 2 問）を置く。
 *   本文は実例ごとに重ならない漢字の並びで作り、止める理由にも警告にも当たらない（正解の選択肢と教材は 14 字続けて一致しない）
 * - badArguments: 同じ学びを置き、束の名前を渡さない
 * - unknownLearning（zzz）・notRoadmap（ip）: 同じ形の学びを置き、束の教材は途中で途切れている（確かめれば止まる）
 * - noAssignment（itc の bundle_99）・notRoadmapBeforeNoAssignment（ip の bundle_99）: 学びはあり、bundle_99 の割り当てが無い
 */

import { defineHandler, Unanswerable } from '../kit/protocol'
import { inShadow, kanjiSource, keyOf, runScript, writeJson } from '../kit/tb'
import { answerOf, argsOf } from '../kit/td'
import type { Shadow } from '../kit/tool'

const LABELS = ['ア', 'イ', 'ウ', 'エ'] as const

/**
 * data/<key> に、論点 count 個を束 bundle_01 に割り当てた学びを置く。brokenMaterials なら束の教材を途中で途切れさせる。
 * @implements REQ-570
 */
async function writeBundleLearning(shadow: Shadow, key: string, count: number, brokenMaterials: boolean): Promise<void> {
  const k = kanjiSource()
  const terms = Array.from({ length: count }, () => k(4))
  const units = terms.map((term, i) => ({ order: i + 1, day: 1, topic_id: i + 1, term, field: '分野', middle: '中項目', summary: `${k(6)}の要約`, prereq: [], goals: [1], sources: [] }))
  await writeJson(shadow, `data/${key}/roadmap.json`, { target: '仕込み', per_day: 3, days: 3, unit_count: count, dropped_no_goal: [], units })
  await writeJson(shadow, `data/${key}/sources/collected.json`, { collected_at: '2026-11-19', collector: 'collected', sources: [{ name: `${k(6)}の手引き`, fetched: true, outline: [] }] })
  await writeJson(shadow, `data/${key}/material_bundles/bundle_01.json`, {
    bundle: 'bundle_01',
    topics: units.map((u) => ({ topic_id: u.topic_id, term: u.term, field: u.field, middle: u.middle, summary: u.summary, goals: u.goals, prereq: [], sources: [] })),
  })
  const materials = units.map((u) => ({
    topic_id: u.topic_id,
    term: u.term,
    explanation: `**${u.term}**とは、${k(10)}のことです。\n\n- **キーワード**: ${k(2)}・${k(2)}・${k(2)}\n\n選考では、${k(8)}を話せるかが見られます。`,
    detail: `### しくみ\n${k(12)}が${k(8)}になります。\n### 面接で話すなら\n${k(10)}を話します。`,
    sources: [],
  }))
  if (brokenMaterials) await shadow.write(`data/${key}/materials/bundle_01.json`, '{"bundle": "bundle_01", "materials": [')
  else await writeJson(shadow, `data/${key}/materials/bundle_01.json`, { bundle: 'bundle_01', materials })
  const questions = units.flatMap((u, i) =>
    [1, 2].map((n) => {
      const answer = LABELS[(i * 2 + n) % 4]
      return {
        qid: `t${u.topic_id}-${n}`,
        topic_id: u.topic_id,
        term: u.term,
        stem: `${k(12)}として合うものはどれか。`,
        choices: Object.fromEntries(LABELS.map((l) => [l, `${k(16)}を選ぶ`])),
        answer,
        reason: `${k(10)}がしくみの段にあります。`,
        choice_notes: Object.fromEntries(LABELS.map((l) => [l, l === answer ? `正解。${k(8)}を選んでいます。` : `${k(8)}を見ていません。`])),
        tests_goal: 1,
      }
    }),
  )
  await writeJson(shadow, `data/${key}/roadmap_questions/bundle_01.json`, { bundle: 'bundle_01', questions })
}

const PRECONDITIONS: Record<string, (shadow: Shadow, key: string) => Promise<void>> = {
  pass: (shadow, key) => writeBundleLearning(shadow, key, 8, false),
  badArguments: (shadow, key) => writeBundleLearning(shadow, key, 2, false),
  unknownLearning: (shadow, key) => writeBundleLearning(shadow, key, 2, true),
  notRoadmap: (shadow, key) => writeBundleLearning(shadow, key, 2, true),
  noAssignment: (shadow, key) => writeBundleLearning(shadow, key, 2, false),
  notRoadmapBeforeNoAssignment: (shadow, key) => writeBundleLearning(shadow, key, 2, false),
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-020',
  parallel: true,
  operations: {
    checkRoadmapBundle: async (line) => {
      const prepare = PRECONDITIONS[line.case]
      if (!prepare) throw new Unanswerable(`UC-020 checkRoadmapBundle の例 ${line.case} の前提を知らない`)
      const key = keyOf(line.request)
      return inShadow(async (shadow) => {
        await prepare(shadow, key)
        return answerOf(await runScript(shadow, 'check_roadmap_bundle.py', argsOf(line.request)), [0, 1])
      })
    },
  },
})

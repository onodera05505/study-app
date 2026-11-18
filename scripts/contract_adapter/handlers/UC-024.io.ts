/**
 * UC-024 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根に置き、関数は影の根を作業ディレクトリにして呼ぶ。
 * - ok: 実例が読むファイルに、契約の例の応答と同じ中身を置く（シラバスは小項目 1 つ、論点の一覧は論点 1 つ）
 * - missing: 読むファイルを置かない
 * - unreadable: 読むファイルに途中で途切れた JSON を置く
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow, writeJson } from '../kit/tb'
import type { Shadow } from '../kit/tool'

const PLAN_21 = {
  unit_no: 21,
  unit: 'データベース',
  overview: '表の形でデータを持ち、キーで表どうしをつなぐ仕組みを学びます。',
  groups: [{ name: '表とキー', description: 'データを表で持ち、行をキーで見分けてつなぐ土台です。', topics: [214, 220, 205, 203] }],
  owners: [],
  prerequisites: { '205': [203] },
}
const SYLLABUS = {
  version: '仕込み',
  items: [{ number: 1, name: '経営・組織論', field: 'ストラテジ系', major_no: 1, major: '企業と法務', middle_no: 1, middle: '企業活動', terms: [] }],
}
const TOPICS = {
  topic_count: 1,
  question_count: 0,
  exams: [],
  topics: [
    {
      id: 9,
      term: 'ITガバナンス',
      match_key: 'ITガバナンス',
      syllabus_item: 32,
      syllabus_item_name: 'システム監査',
      field: 'マネジメント系',
      major: 'サービスマネジメント',
      middle: 'システム監査',
      is_new: false,
      related_terms: [],
      question_count: 0,
      questions: [],
    },
  ],
}

/** 例の名前ごとに、request の path に置く物（undefined は置かない）。 */
function readOperation(okContent: unknown): Operation {
  return async (line: ExampleLine) => {
    const path = field(line.request, 'path')
    if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に path が無い`)
    const put: Record<string, ((shadow: Shadow) => Promise<void>) | undefined> = {
      ok: (shadow) => writeJson(shadow, path, okContent),
      missing: undefined,
      unreadable: (shadow) => shadow.write(path, '{"items": ['),
    }
    if (!(line.case in put)) throw new Unanswerable(`${line.uc} ${line.operation} の例 ${line.case} の前提を知らない`)
    return inShadow(async (shadow) => {
      await put[line.case]?.(shadow)
      return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
    })
  }
}

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-024',
  parallel: true,
  operations: {
    readUnitPlan: readOperation(PLAN_21),
    readSyllabusUnits: readOperation(SYLLABUS),
    readTopicUnits: readOperation(TOPICS),
  },
})

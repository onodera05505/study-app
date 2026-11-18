/**
 * UC-025 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根に置き、関数は影の根を作業ディレクトリにして呼ぶ。
 * - ok: 実例が読むファイルに、契約の例の応答と同じ中身を置く（図の仕様は図の種類と論点の名前も持つ）
 * - missing: 読むファイルを置かない
 * - unreadable: 読むファイルに途中で途切れた JSON を置く
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow, writeJson } from '../kit/tb'
import type { Shadow } from '../kit/tool'

const FIGURE_1 = {
  topic_id: 1,
  term: 'サービスデスク',
  figures: [{ id: 1, type: 'blocks', after: '### 窓口を一つにする理由', caption: '問合せの窓口を一つにまとめる流れを表します。', nodes: [], edges: [] }],
}
const BUNDLE_21_2 = {
  bundle: '21-2',
  materials: [{ topic_id: 201, term: '選択・結合', explanation: '**選択・結合**とは、…です。', detail: '### 3 つの関係演算の違い\n…' }],
}

function readOperation(okContent: unknown): Operation {
  return async (line: ExampleLine) => {
    const path = field(line.request, 'path')
    if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に path が無い`)
    const put: Record<string, ((shadow: Shadow) => Promise<void>) | undefined> = {
      ok: (shadow) => writeJson(shadow, path, okContent),
      missing: undefined,
      unreadable: (shadow) => shadow.write(path, '{"topic_id": 2, "figures": ['),
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
  uc: 'UC-025',
  parallel: true,
  operations: {
    readFigureSpec: readOperation(FIGURE_1),
    readRewrittenMaterialFile: readOperation(BUNDLE_21_2),
  },
})

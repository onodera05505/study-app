/**
 * UC-018 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根に置き、関数は影の根を作業ディレクトリにして呼ぶ。登録簿は影の根に写した物（kit/tb.ts の inShadow）。
 * - ok: 実例が読むファイルに、契約の例の応答と同じ中身を置く（readFigure は配信の置き場に図の画像を置く。readLearningKind は登録簿のまま）
 * - missing・unknown: 読むファイルを置かない（readLearningKind は登録簿に無い学び）
 * - unreadable: 読むファイルに途中で途切れた JSON を置く
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow, writeJson } from '../kit/tb'
import type { Shadow } from '../kit/tool'

/** path を読む操作。ok の中身は契約の例の応答。 */
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

/** 登録簿から学びの種類を読む（登録簿は影の根に写した物のまま）。 */
const readLearningKind: Operation = async (line) => {
  if (!['ok', 'unknown'].includes(line.case)) throw new Unanswerable(`UC-018 readLearningKind の例 ${line.case} の前提を知らない`)
  return inShadow(async (shadow) => pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root })))
}

/** 図の行が指す画像を配信の置き場から読む（ok は public の下の同じパスに画像を置く）。 */
const readFigure: Operation = async (line) => {
  const src = field(line.request, 'src')
  if (src === undefined) throw new Unanswerable('UC-018 readFigure の request に src が無い')
  if (!['ok', 'missing'].includes(line.case)) throw new Unanswerable(`UC-018 readFigure の例 ${line.case} の前提を知らない`)
  return inShadow(async (shadow) => {
    if (line.case === 'ok') await shadow.write(`public${src}`, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n')
    return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
  })
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-018',
  parallel: true,
  operations: {
    readLearningKind,
    readTopics: readOperation({ topics: [{ id: 9, term: 'ITガバナンス' }] }),
    readPastQuestions: readOperation({ questions: [{ text: '…' }] }),
    readMaterialFile: readOperation({ materials: [{ topic_id: 395, term: '経営理念（企業理念）', explanation: '**経営理念**（企業理念）とは…', detail: '### …' }] }),
    readMaterialBundle: readOperation({ topics: [{ topic_id: 10 }] }),
    readFigure,
  },
})

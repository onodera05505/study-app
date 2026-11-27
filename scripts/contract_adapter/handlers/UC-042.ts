/**
 * UC-042 の受け持ち（束を作り教材を手入れし学びを足す道具 9 個。入口は CLAUDE.md の「道具を回す操作」の行: 操作名を snake_case にした
 * `scripts/<名前>.py`）。request の各欄は同じ名前の引数（newTarget の key は第 1 引数。大文字の前に - を入れた小文字）。
 *
 * 道具は学びの置き場や登録簿を書き換えうるので、実例ごとの影の根（kit/td.ts の projectShadow）で回し、道具が読み書きする学びの置き場は
 * 影の根の中の写しにする。前提はどの実例も ok で、リポジトリの今の状態の写し:
 * - buildAnswerabilityBundles・buildExplanationBundles・buildMaterialBundles: ip の写し
 * - planMaterialFigures: ap の写し、planRoadmapFigures: itc の写し、scanWords: msg の写し、tightenNumberUnits: mkt の写し
 * - summarizeReview: 全部の学びの置き場（リンクのまま。道具は読むだけ）
 * - newTarget（check）: 影の根の写しの登録簿と配備先の一覧。影の根は git の作業ツリーで、索引にリポジトリの索引の並びを入れる
 *   （登録簿の整合の確かめは、追跡を確かめられない置き場では失敗で終える）
 * 応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 */

import { defineHandler, type ExampleLine, type Operation } from '../kit/protocol'
import { answerOf, argsOf, inShadow, unknownCase } from '../kit/td'

const tool =
  (script: string, learnings: string[], codes: number[], positional: string[] = [], git = false): Operation =>
  (line: ExampleLine) => {
    if (line.case !== 'ok') unknownCase(line)
    return inShadow({ learnings, git }, async (s) => answerOf(await s.run(['python3', `scripts/${script}`, ...argsOf(line.request, { positional })], 300_000), codes))
  }

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-042',
  parallel: true,
  operations: {
    buildAnswerabilityBundles: tool('build_answerability_bundles.py', ['ip'], [0]),
    buildExplanationBundles: tool('build_explanation_bundles.py', ['ip'], [0]),
    buildMaterialBundles: tool('build_material_bundles.py', ['ip'], [0]),
    planMaterialFigures: tool('plan_material_figures.py', ['ap'], [0]),
    planRoadmapFigures: tool('plan_roadmap_figures.py', ['itc'], [0]),
    scanWords: tool('scan_words.py', ['msg'], [0]),
    summarizeReview: tool('summarize_review.py', [], [0, 1]),
    tightenNumberUnits: tool('tighten_number_units.py', ['mkt'], [0]),
    newTarget: tool('new_target.py', [], [0, 1], ['key'], true),
  },
})

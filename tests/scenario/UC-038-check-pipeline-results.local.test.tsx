/** UC-038「取り込み・分類・書き直しの結果と手順書の書き換えを、機械で確かめる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。各結果の誤りと前の版が取れない場合は各要件のテストが見る）。
 *  作り手は手元の作業ツリーで、契約の実例（ok）と同じ入力で 5 つの道具を順に回す（入口は CLAUDE.md の「道具を回す操作」の行）。 */

import { describe, expect, it } from 'vitest'
import { type ToolRun, crashed, runReal } from '../server/UC-037_fixture.local'

describe('UC-038 取り込み・分類・書き直しの結果と手順書の書き換えを、機械で確かめる', () => {
  // @scenario UC-038
  it('作り手が 5 つの結果を照らすと、それぞれの結果が挙げられて終わり、次の手順へ回せる物を見分けられる', () => {
    const runs: Array<[string, ToolRun]> = [
      // 1. 抽出した問題文だけで解いた結果を、回を指定して正解表と照らす
      ['問題文で解いた結果', runReal('check_answerability.py', ['2024r06'])],
      // 2. 教材だけで解いた結果を正解表と照らす
      ['教材で解いた結果', runReal('check_answerability_materials.py', ['--data', 'data/ip', '--results', 'data/ip/answerability_results'])],
      // 3. 分類の結果を確かめる
      ['分類', runReal('check_classified.py', ['--data', 'data/ap'])],
      // 4. 書き直した世代で前の世代から落ちた語を確かめる
      ['書き直しの落ち', runReal('check_material_coverage.py', ['--data', 'data/ip'])],
      // 5. 書き換えた手順書に前の版の決まりが残っているかを確かめる
      ['手順書の書き換え', runReal('spec_inventory.py', ['scripts/prompts/write_materials.md'])],
    ]
    // 6〜7. システムがそれぞれの結果を挙げて終え、作り手が挙がった物を見る
    for (const [label, r] of runs) {
      expect(crashed(r), `${label}: ${r.out}`).toBe(false)
      expect(r.status, `${label}: ${r.out}`).toBe(0)
      expect(r.stdout.trim().length, `${label}: 結果が挙げられていない`).toBeGreaterThan(0)
    }
  }, 300_000)
})

/** UC-042「書き手と担当に渡す束を作り、教材の手入れと学びの追加を道具で回す」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。束の中身・並べ方・合言葉・比率の食い違い・指摘が無い場合は各要件のテストが見る）。
 *  道具は影の根（tests/server/UC-042_fixture.ts）で、OS の囲いの中で回し、書き出しは影の根の中に向ける。 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { jsonFiles, outOf, ownLearning, removeShadows, run42, shadow42 } from '../server/UC-042_fixture'

afterAll(async () => {
  await removeShadows()
})

describe('UC-042 書き手と担当に渡す束を作り、教材の手入れと学びの追加を道具で回す', () => {
  // @scenario UC-042
  it('作り手が学びを登録し、束を作り、図を付ける論点を選び、教材を手入れすると、それぞれの結果が書き出されるか示される', async () => {
    const s = shadow42('scenario')
    ownLearning(s, 'mkt')
    mkdirSync(s.path('out'), { recursive: true })
    // 1. 作り手が、新しい学びを登録する
    const reg = await run42(s, 'new_target.py', ['zzq', '--kind', 'roadmap', '--name', '仕込みの学び', '--target-name', '仕込みの題材', '--fields', '基礎,応用', '--per-day', '3', '--days', '14'])
    expect(reg.code, outOf(reg)).toBe(0)
    expect((JSON.parse(readFileSync(s.path('src/shared/targets.json'), 'utf8')) as Record<string, unknown>).zzq).toBeDefined()
    // 2. 作り手が、教材・問題解説・解ける度合いの確かめの担当に渡す束を作る
    const ans = await run42(s, 'build_answerability_bundles.py', ['--data', 'data/ip', '--out', 'out/ans', '--size', '3', '--only', '2', '9', '10'])
    const expl = await run42(s, 'build_explanation_bundles.py', ['--data', 'data/ip', '--out', 'out/expl', '--only', '2', '9', '10'])
    const mat = await run42(s, 'build_material_bundles.py', ['--data', 'data/ip', '--out', 'out/mat', '--only', '2', '9', '10'])
    for (const r of [ans, expl, mat]) expect(r.code, outOf(r)).toBe(0)
    for (const d of ['out/ans', 'out/expl', 'out/mat']) expect(jsonFiles(s.path(d)).length, `${d} に束が無い`).toBeGreaterThan(0)
    // 3. 作り手が、図を付ける論点を選ぶ
    const fig = await run42(s, 'plan_material_figures.py', ['--data', 'data/ap', '--out', 'out/plan.json'])
    expect(fig.code, outOf(fig)).toBe(0)
    expect(existsSync(s.path('out/plan.json'))).toBe(true)
    // 4. 作り手が、教材の禁じた語と数字と単位の空白を確かめ、読み直しの指摘を集計する
    const scan = await run42(s, 'scan_words.py', ['--data', 'data/mkt', '--bold'])
    const tighten = await run42(s, 'tighten_number_units.py', ['--data', 'data/mkt', '--dry-run'])
    const review = await run42(s, 'summarize_review.py', ['--key', 'ip'])
    // 5. システムが、それぞれの結果を示す
    for (const r of [scan, tighten, review]) {
      expect(r.code, outOf(r)).toBe(0)
      expect(r.out.trim().length).toBeGreaterThan(0)
    }
  }, 300_000)
})

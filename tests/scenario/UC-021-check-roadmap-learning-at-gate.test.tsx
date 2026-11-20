/** UC-021「ロードマップ型の学び全体を配る前に教材の門で確かめる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止まる場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時の作業場に置き、そこを作業の場所にして学び全体の門（checkRoadmap）を呼ぶ。
 *  学びの置き場は、仕込み（tests/server/UC-021_fixture.ts）の章で束ねて印を持つ eng の学び全体（12 単位）で、
 *  止める理由に当たらない学びに、警告だけが当たる箇所（避ける語・列の多すぎる表）と、情報の量の多い教材を 1 つ足す。
 *  独立解答は 2 つ（全問一致・20 問中 2 問の食い違い）を添える。 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  LIMITS, REGISTRY, allQuestions, answersWith, cleanupWorkspaces, detailOf, findingsAbout, grid, learning, materialAt,
  perfectAnswers, runGate, table, unitAt, unitNeedles,
} from '../server/UC-021_fixture'

afterAll(cleanupWorkspaces)

describe('UC-021 ロードマップ型の学び全体を配る前に教材の門で確かめる', () => {
  // @scenario UC-021
  it('UC-021 ロードマップ型の学び全体を配る前に教材の門で確かめる', () => {
    const l = learning('eng', 12)
    const avoid = materialAt(l, 2)
    avoid.explanation = avoid.explanation!.replace(/です。$/, `${REGISTRY.eng.roadmapSpec.ngWords[0]}の${l.fresh(4)}です。`)
    materialAt(l, 4).detail = detailOf(l, table(grid(l, LIMITS.tableColumns.max + 1, 3)))
    const long = materialAt(l, 6)
    long.explanation += `\n\n${Array.from({ length: 40 }, () => `${l.fresh(40)}です。`).join('')}`

    // step 1: 作り手が、学び全体を、書き手の独立解答を添えて教材の門にかける
    const r = runGate(l, { 'solve_A.json': { solver: 'A', answers: perfectAnswers(l) }, 'solve_B.json': answersWith(l, 2) })
    expect(r.json, `門の結果が標準出力の最後の行に無い: ${r.stdout.slice(-400)}${r.stderr.slice(-400)}`).not.toBeNull()
    const result = r.json
    const stopsOf = (...kinds: string[]) => kinds.flatMap((k) => findingsAbout(result.stops, k))

    // step 2: ロードマップの学ぶ順・章・印・要約がそろっている
    expect(stopsOf('prereqAfter', 'summaryMissing', 'chapterMissing', 'tierMissing'), 'そろったロードマップを止めた').toEqual([])

    // step 3: どの単位にも教材があり、必須の要素・記法・出典・用語・禁じた書き方に当たらない
    expect(
      stopsOf('unreadableOutput', 'duplicate', 'termMismatch', 'missingMaterial', 'missingElement', 'brokenTable', 'headingLevel', 'unknownSource', 'unresolvedTerm', 'bannedPattern'),
      'そろった教材を止めた',
    ).toEqual([])

    // step 4: 確認問題の形と単位ごとの数がそろい、独立解答と正解の食い違いが閾値の内にある
    expect(stopsOf('questionShape', 'unknownGoal', 'duplicateQid', 'questionCount', 'independentMismatch'), 'そろった確認問題か閾値の内の独立解答を止めた').toEqual([])

    // step 5: 情報の量を見ずに、表示の制約と書き方の気になる所を警告として挙げる
    expect(findingsAbout(result.warnings, 'avoidWord', ...unitNeedles(unitAt(l, 2))).length, '避ける語の警告が無い').toBeGreaterThan(0)
    expect(findingsAbout(result.warnings, 'tableTooWide', ...unitNeedles(unitAt(l, 4))).length, '表示の制約の外の表の警告が無い').toBeGreaterThan(0)
    expect(findingsAbout([...result.stops, ...result.warnings], null, ...unitNeedles(unitAt(l, 6))), '情報の量の多い教材を挙げた').toEqual([])

    // step 6: 見た論点と問題の数、警告、止める理由を末尾の機械向けの 1 行で返し、止める理由が無いので通す
    expect(r.lines.length, '人が読む結果の行が無い').toBeGreaterThanOrEqual(2)
    expect(result.topics, '見た論点の数がロードマップの単位の数と違う').toBe(l.roadmap.units.length)
    expect(result.questions, '見た問題の数が確認問題の数と違う').toBe(allQuestions(l).length)
    expect(result.stops, '止める理由が無いのに止める理由を返した').toEqual([])
    expect(result.limits).toEqual(LIMITS)
    expect(result.exitCode).toBe(0)

    // step 7 と成功時: 作り手が、通ったことと、見た論点と問題の数と警告を見ている
    expect(r.code, '止める理由が無いのに通さなかった').toBe(0)
    for (const f of result.warnings) {
      expect(typeof f.where === 'string' && f.where.length > 0 && typeof f.reason === 'string' && f.reason.length > 0, '警告に箇所か理由が無い').toBe(true)
    }
  }, 120_000)
})

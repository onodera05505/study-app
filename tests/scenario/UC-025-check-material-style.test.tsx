/** UC-025「書き直した世代の資格対策の教材を様式の門で確かめる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止まる場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時の作業場に置き、そこを作業の場所にして様式の門（checkMaterialStyle）を呼ぶ。
 *  学びの置き場は、仕込み（tests/server/UC-025_fixture.ts）の資格対策の ip で、
 *  止める理由に当たらない書き直した世代に、警告の 4 種類が 1 つずつ当たる箇所を足す。 */

import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIMITS, type Workspace, makeWorkspace, names, ofKind, previousMaterial, v4Material } from '../server/UC-025_fixture'

let ws: Workspace

beforeEach(() => {
  ws = makeWorkspace()
})

afterEach(() => {
  rmSync(ws.dir, { recursive: true, force: true })
})

describe('UC-025 書き直した世代の資格対策の教材を様式の門で確かめる', () => {
  // @scenario UC-025
  it('止める理由の無い書き直した世代を様式の門にかけ、通した結果と見た論点の数と警告を受け取る', () => {
    const seen = Object.values(ws.model.v4).flat().map((m) => m.topic_id)

    // 警告だけが当たる箇所: 問われ方の文・同じ点の繰り返し・受け持ちの説明の繰り返し・前の世代から消えた数値
    const examPhrase = v4Material(ws, 311)
    examPhrase.explanation += `\n\n- 試験では${ws.fresh(8)}です。`
    const sameTopic = v4Material(ws, 313)
    const repeated = ws.fresh(24)
    sameTopic.explanation += `\n\n- ${repeated}です。`
    sameTopic.detail += `\n${repeated}です。`
    const sharedInUnit = ws.fresh(36)
    v4Material(ws, 315).detail += `\n${sharedInUnit}です。`
    v4Material(ws, 316).detail += `\n${sharedInUnit}です。`
    previousMaterial(ws, 312).explanation += `\n\n- ${ws.fresh(6)}は80件です。`
    ws.materialize()

    // step 1: 作り手が、書き直した世代の教材を様式の門にかける
    const r = ws.gate({ data: `data/${ws.model.key}`, dir: ws.model.dir })
    expect(r.json, `門の結果が標準出力の JSON に無い: ${r.stderr}`).toBeDefined()
    const result = r.json

    // step 2: 書き直した世代の論点が、止める理由の無い単元の構成のまとまりに入っている
    expect(ofKind(result.stops, 'unitPlanStops'), '止める理由の無い単元の構成を止めた').toEqual([])
    expect(ofKind(result.stops, 'topicNotInPlan'), 'まとまりに入っている論点を止めた').toEqual([])

    // step 3: 短い説明の直後に置く図は論点ごとに 1 枚まで
    expect(ofKind(result.stops, 'explanationFigures'), '短い説明の直後に置く図が 1 枚の論点を止めた').toEqual([])

    // step 4: 問われ方の文・同じ点の繰り返し・受け持ちの説明の繰り返し・前の世代から消えた数値を警告として挙げる
    expect(ofKind(result.warnings, 'examPhrase').some((f) => names(f, 311)), '問われ方の文の警告が無い').toBe(true)
    expect(ofKind(result.warnings, 'sameTopicRepeat').some((f) => names(f, 313)), '同じ点の繰り返しの警告が無い').toBe(true)
    expect(ofKind(result.warnings, 'sameUnitRepeat').some((f) => names(f, 315) || names(f, 316)), '受け持ちの説明の繰り返しの警告が無い').toBe(true)
    expect(ofKind(result.warnings, 'lostNumber').some((f) => names(f, 312)), '前の世代から消えた数値の警告が無い').toBe(true)

    // step 5: 見た論点の数、警告、止める理由を返し、止める理由が無いので通す
    expect(result.stops, '止める理由が無いのに止める理由を返した').toEqual([])
    expect(result.exitCode).toBe(0)
    expect(r.status, '止める理由が無いのに通さなかった').toBe(0)
    expect(result.topics, '見た論点の数が書き直した世代の論点の数と違う').toBe(seen.length)
    expect(result.limits).toEqual(LIMITS)

    // 成功時: 作り手が「止める理由が無い」という門の結果と、見た論点の数と警告を見ている
    expect(result.warnings.length, '警告が作り手に返っていない').toBeGreaterThanOrEqual(4)
    for (const f of result.warnings) {
      expect(typeof f.where === 'string' && f.where.length > 0 && typeof f.reason === 'string' && f.reason.length > 0, '警告に箇所か理由が無い').toBe(true)
    }
  }, 120_000)
})

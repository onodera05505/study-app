import { afterAll, describe, expect, it } from 'vitest'
import { type ToolRun, dataShadow, refusalOf, removeTemps, runTool } from './UC-033_fixture'

/**
 * UC-033 の REQ-571: 作り手と運用者が手元で回す道具が、自分の持ち物の操作の契約の errors に当たって止まるとき、
 * 標準出力に断りの種類の名前と理由を 1 つずつ持つ形（共有の形 ToolError）を出し、0 でない終了の状態で終える。
 *
 * 入口は道具そのもの（`scripts/<操作名を snake_case にした名前>.py` を子プロセスで回す）。名前の読み方は
 * `CLAUDE.md` の「操作 → 入口」（標準出力の全体を JSON として読み、読めなければ最後の空でない行。その `error.code`）。
 * 期待する名前は、その入力が当たる契約の errors の条件の code。理由の文の文言は照らさない（空でない文があることだけ見る）。
 *
 * 道具の選び方（全部の失敗例は確かめ（contract-run）が回すので、クラスを反証できる最小の組）:
 * - 入口の引数: UC-032 の checkSource（知らない引数）・checkRoadmapRegistry（学びを渡さない・登録簿に無い学び）、
 *   UC-024 の checkUnitPlans（登録簿に無い学び）
 * - 読むファイル: UC-024 の checkUnitPlans（道具を回す操作）の errors のうち、読むファイルに当たる条件（「シラバスか論点の一覧が無い」NOT_FOUND・
 *   「シラバスか論点の一覧が読めない」INVALID_INPUT）。シラバスを置かない・壊した学びの置き場を作業の場所に写して作る。読み書きの操作 1 つの失敗の名前は REQ-579 で、ここでは見ない
 * - 終了の状態が同じで種類が 2 つ: UC-024 の checkUnitPlans（契約の ToolError は断りの終了の状態を 2 と決める）の INVALID_INPUT と NOT_FOUND
 */

/** 断りの形を確かめ、名前を返す。 */
const expectRefusal = (run: ToolRun, code: string, label: string) => {
  expect(run.code, `${label}: 終了の状態が 0`).not.toBe(0)
  const refusal = refusalOf(run.stdout)
  expect(refusal, `${label}: 標準出力に断りの形が無い:\n${run.stdout}\n${run.stderr}`).toBeDefined()
  expect(refusal?.code, `${label}: 断りの種類の名前`).toBe(code)
  expect(typeof refusal?.reason === 'string' && refusal.reason.trim() !== '', `${label}: 理由の文が無い`).toBe(true)
  return refusal?.code
}

afterAll(async () => {
  await removeTemps()
})

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  describe('REQ-571 道具が契約の errors に当たって止まるとき、標準出力に名前と理由を出して 0 でない終了の状態で終える', () => {
    // @covers REQ-571#entry-refusal
    it('ソースの門（checkSource）: 知らない引数を渡すと INVALID_INPUT', async () => {
      // 契約 UC-032 checkSource の unknownArgument
      expectRefusal(await runTool('check_source.py', ['--verbose']), 'INVALID_INPUT', '知らない引数 --verbose')
    })

    // @covers REQ-571#entry-refusal
    it('登録簿の門（checkRoadmapRegistry）: 学びを渡さない・登録簿に無い学びは INVALID_INPUT', async () => {
      // 契約 UC-032 checkRoadmapRegistry の noLearning・unknownLearning
      expectRefusal(await runTool('check_roadmap_registry.py', []), 'INVALID_INPUT', '学びを渡さない')
      expectRefusal(await runTool('check_roadmap_registry.py', ['zzz']), 'INVALID_INPUT', '登録簿に無い学び zzz')
    })

    // @covers REQ-571#entry-refusal
    it('単元の構成の門（checkUnitPlans）: 登録簿に無い学びは INVALID_INPUT', async () => {
      // 契約 UC-024 checkUnitPlans の unknownLearning
      expectRefusal(await runTool('check_unit_plans.py', ['--data', 'data/zzz']), 'INVALID_INPUT', '登録簿に無い学び data/zzz')
    })

    // @covers REQ-571#file-refusal
    it('単元の構成の門が読むシラバスが無ければ NOT_FOUND、形として読めなければ INVALID_INPUT', async () => {
      // 契約 UC-024 checkUnitPlans の syllabusMissing・syllabusUnreadable の条件
      const missing = dataShadow('ip', { omit: ['syllabus.json'] })
      expectRefusal(await runTool('check_unit_plans.py', ['--data', 'data/ip'], missing), 'NOT_FOUND', 'シラバスが無い')
      const unreadable = dataShadow('ip', { replace: { 'syllabus.json': '{ JSON でない' } })
      expectRefusal(await runTool('check_unit_plans.py', ['--data', 'data/ip'], unreadable), 'INVALID_INPUT', 'シラバスが JSON として読めない')
    })

    // @covers REQ-571#same-exit-different-name
    it('単元の構成の門: 登録簿に無い学びとシラバスが無い学びは、終了の状態が同じで名前が違う', async () => {
      const unknown = await runTool('check_unit_plans.py', ['--data', 'data/zzz'])
      const missing = await runTool('check_unit_plans.py', ['--data', 'data/ip'], dataShadow('ip', { omit: ['syllabus.json'] }))
      expect(unknown.code, '登録簿に無い学びの終了の状態').toBe(2)
      expect(missing.code, 'シラバスが無い学びの終了の状態').toBe(2)
      const a = expectRefusal(unknown, 'INVALID_INPUT', '登録簿に無い学び')
      const b = expectRefusal(missing, 'NOT_FOUND', 'シラバスが無い')
      expect(a, '終了の状態が同じ 2 つの断りの名前が同じ').not.toBe(b)
    })
  })
})

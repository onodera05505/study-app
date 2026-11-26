/** UC-033「確定した契約の実例を実装に当て、契約どおりに応えない版を見つける」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。合わない・不備・渡せない実例、前提と回す順、道具の断りの形は各要件のテストが見る）。
 *
 *  運用者は確かめを回す入口 `npm run contract-run` を、手元の作業ツリー（配信しようとする版のソースと確定した契約）で
 *  1 回回す。結果は `--json` で読む（`.harness/tools/run-cases/README.md`）。
 *  時間の上限は、確かめに `--timeout` で渡す（RUN_TIMEOUT_S）。テストは記録つきの全体の中（子のプロセスに記録の仕掛けが付き、ほかのテストの後ろで回る）
 *  でも回し終えるだけの値を渡し、それより長くは待たない。確かめの既定（全実行 120 秒）の中で終わることは、検査の一式の run cases の段が見る。
 *  事後条件の「本番の保存先・配備先・外の相手には何も送られていない」は、子のプロセスすべての外向きの通信を
 *  記録する囲い（`tests/server/UC-033_fixture.local.ts` の openWitness）の記録が空であることで見る。 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ContractRunResult,
  type Witness,
  RUN_TIMEOUT_S,
  contractRun,
  explainNotPassed,
  keyOf,
  limitMsFor,
  openWitness,
  ownedFixedExamples,
  removeTemps,
  tailOf,
} from '../server/UC-033_fixture.local'

/** 確かめの時間の上限（RUN_TIMEOUT_S。土台が 1 か所で持つ）に、npm とアダプターの立ち上がりの分を足した待ちの上限。 */
const LIMIT_MS = limitMsFor(RUN_TIMEOUT_S)

let witness: Witness
let run: ContractRunResult
let sent: string[]

beforeAll(async () => {
  witness = await openWitness()
  // 1. 運用者が、契約の実例の確かめを回す
  run = await contractRun(['--json', '--timeout', String(RUN_TIMEOUT_S)], { env: witness.env, limitMs: LIMIT_MS })
  sent = witness.sent()
}, LIMIT_MS + 30_000)

afterAll(async () => {
  await witness?.close()
  await removeTemps()
})

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  // @scenario UC-033
  it('確かめを回すと、確定した契約の自分の持ち物の操作の実例がすべて実装に渡されて合い、外には何も送られない', () => {
    expect(run.code, `確かめが時間の上限（${LIMIT_MS / 1000} 秒）までに終わらなかった`).not.toBe(-1)
    expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()

    // 2–4. 確定した契約の自分の持ち物の操作の実例が 1 件ずつ実装に渡されて照らされる
    const expected = ownedFixedExamples().map(keyOf).sort()
    const got = (run.results ?? []).map(keyOf).sort()
    expect(got, '渡された実例が、確定した契約の自分の持ち物の操作の実例と一致しない').toEqual(expected)

    // 5. 運用者が、すべての実例が合ったことを見る
    const notPassedVerdicts = (run.results ?? []).filter((r) => r.verdict !== 'pass')
    const notPassed = notPassedVerdicts.map((r) => `${r.verdict} ${keyOf(r)} ${r.detail ?? ''}`)
    expect(notPassed, explainNotPassed(run, notPassedVerdicts)).toEqual([])
    expect(run.summary).toEqual({ pass: expected.length, fail: 0, skip: 0 })
    expect(run.code, tailOf(run)).toBe(0)

    // 本番の保存先・配備先・外の相手には何も送られていない
    expect(sent, '手元の外へ送られかけた').toEqual([])
  })
})

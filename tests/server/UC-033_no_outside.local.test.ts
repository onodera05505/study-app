import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ContractRunResult, type Witness, contractRun, keyOf, openWitness, opWith, realOp, removeTemps, runsTestMs, shadowSpec, tailOf, verdictOf } from './UC-033_fixture.local'

/**
 * UC-033 の REQ-569: 本番の保存先・配備先・外の相手に触れる操作の実例を回しても、確かめはそれらに何も送らない。
 *
 * 外から観測する形: 確かめ（アダプターと、アダプターが回す道具と実装を含む子のプロセスすべて）の外向きの通信を、
 * このテストが立てた記録する代理（HTTP(S)_PROXY。curl・python・wrangler・node の fetch が通る）と、
 * node の外向きの接続を記録して断る前置きに集める。手元（loopback）の外へ送られかけた物があれば記録に残り、
 * どこにも届かない。本番の保存先（D1 の remote）と配備先（Pages）は Cloudflare の API の向こうにあり、
 * 外の相手（まなびば・配備の死活確認）も手元の外にあるので、3 つとも手元の外への通信として現れる。
 *
 * 回す実例は本物の契約の操作の全実例（操作ごとに影の根の契約に写す）。結果が合うかはここでは見ない（REQ-567・568）が、
 * 実例が確かめに渡されたこと（結果に挙がること）は見る（渡さずに送らないのでは確かめにならない）。
 */

let witness: Witness

beforeAll(async () => {
  witness = await openWitness()
})

afterAll(async () => {
  await witness.close()
  await removeTemps()
})

/** 本物の契約の操作をそのまま写して確かめを回し、送られかけた物を返す。 */
const runOps = async (ops: Array<[uc: string, op: string]>, args: string[] = []): Promise<{ run: ContractRunResult; sent: string[] }> => {
  const byUc = new Map<string, Record<string, ReturnType<typeof realOp>>>()
  for (const [uc, op] of ops) byUc.set(uc, { ...(byUc.get(uc) ?? {}), [op]: opWith(uc, op, realOp(uc, op).examples ?? {}) })
  const root = shadowSpec([...byUc].map(([uc, operations]) => ({ uc, operations })))
  const before = witness.sent().length
  const run = await contractRun(['--root', root, '--json', ...args], { env: witness.env })
  return { run, sent: witness.sent().slice(before) }
}

/** 操作の全実例が結果に挙がっている（確かめに渡された）こと。 */
const expectRan = (run: ContractRunResult, ops: Array<[uc: string, op: string]>) => {
  expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()
  for (const [uc, op] of ops) {
    for (const name of Object.keys(realOp(uc, op).examples ?? {})) {
      const k = { uc, operation: op, case: name }
      expect(verdictOf(run, k), `${keyOf(k)} が確かめに渡されていない:\n${tailOf(run)}`).toBeDefined()
    }
  }
}

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  describe('REQ-569 契約の実例の確かめの中で、本番の保存先・配備先・外の相手に何も送らない', () => {
    // @covers REQ-569#production-store
    it('本番の保存先を読み書きする操作（投入を保存先へ流す手続き・流したあとの突き合わせ）の実例を回しても、手元の外に何も送らない', async () => {
      const ops: Array<[string, string]> = [
        ['UC-032', 'seedRemote'],
        ['UC-027', 'verifySeedRemote'],
      ]
      const { run, sent } = await runOps(ops)
      expectRan(run, ops)
      expect(sent, '本番の保存先へ送られかけた').toEqual([])
    }, runsTestMs())

    // @covers REQ-569#deploy-target
    it('配備先に触れる操作（配備先から秘密の名前の一覧を取る）の実例は、写しの操作も回すと指定したときだけ回り、回しても手元の外に何も送らない', async () => {
      const ops: Array<[string, string]> = [['UC-015', 'listDeploymentSecretNames']]
      expect(realOp(...ops[0]).owned, '他者の形を写した操作でない').toBe(false)
      // 指定しなければ回らない
      const plain = await runOps(ops)
      for (const name of Object.keys(realOp(...ops[0]).examples ?? {})) {
        const k = { uc: ops[0][0], operation: ops[0][1], case: name }
        expect(verdictOf(plain.run, k), `${keyOf(k)} が指定なしで回った:\n${tailOf(plain.run)}`).toBeUndefined()
      }
      expect(plain.sent, '配備先へ送られかけた').toEqual([])
      // 指定すれば全実例が回り、それでも配備先に何も届かない
      const { run, sent } = await runOps(ops, ['--include-external'])
      expectRan(run, ops)
      expect(sent, '配備先へ送られかけた').toEqual([])
    }, runsTestMs(2)) // 指定なし・指定あり

    // @covers REQ-569#external-party
    it('外の相手を呼ぶ操作（本番の検査が配備を外から叩く 4 つ・学び側からまなびばへの使い捨てコードの交換・版の印を取りに行く）の実例を回しても、手元の外に何も送らない', async () => {
      const ops: Array<[string, string]> = [
        ['UC-015', 'checkDeploymentHealth'],
        ['UC-015', 'readDeploymentHealthHeaders'],
        ['UC-015', 'openDeploymentEntry'],
        ['UC-015', 'probeRetiredPasswordRoute'],
        ['UC-013', 'signInWithCode'],
        ['UC-016', 'fetchVersionStamp'],
      ]
      const { run, sent } = await runOps(ops)
      expectRan(run, ops)
      expect(sent, '外の相手へ送られかけた').toEqual([])
    }, runsTestMs())
  })
})

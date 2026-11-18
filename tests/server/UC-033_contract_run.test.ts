import { afterAll, describe, expect, it } from 'vitest'
import {
  CONTRACTS,
  type ContractRunResult,
  type ExampleKey,
  contractRun,
  keyOf,
  opWith,
  realExample,
  realOp,
  removeTemps,
  shadowDocs,
  shadowRoot,
  tailOf,
  verdictOf,
} from './UC-033_fixture'

/**
 * UC-033 の REQ-567・568・570: 契約の実例の確かめ（`npm run contract-run`）が、実例を実装に渡して照らし、
 * 合ったときだけ通り、合わない・不備・渡せない実例を挙げて失敗で終え、実例の結果が前提と回す順で変わらないこと。
 *
 * 照らす相手の実装は本物のまま。合わない実例は、本物の契約の操作と実例（名前と入力）を写した影の置き場（`--docs`）で
 * 照らす側だけを差し替えて作る。名前を出さずに断る実装・応えない実装は、影の根（`--root`）で道具 1 本だけを差し替えて作る。
 *
 * 使う操作と実例（どれも本物の契約の物）:
 * - UC-017 getHealth の ok（応答 { ok: true }）
 * - UC-024 checkUnitPlans の pass（応答に exitCode・units・topics・stops・warnings・limits を持つ）と unknownLearning（INVALID_INPUT）
 * - UC-032 checkSource の unknownArgument（INVALID_INPUT）
 * - UC-027 checkSeed の withProblems（応答が終了の状態 1 だけ）、UC-001 getGlossary の ok（合う実例として混ぜる）
 * - 死活確認（UC-017 getHealth）の wire の成功の状態だけを 201 にした写し（実装の 200 を名前の無い断りにする）
 * 理由の文と失敗を示す文の文言は照らさない（REQ-568 の検証しない）。
 */

const HEALTH = ['UC-017', 'getHealth'] as const
const PLANS = ['UC-024', 'checkUnitPlans'] as const
const SOURCE = ['UC-032', 'checkSource'] as const
const SEED = ['UC-027', 'checkSeed'] as const
const GLOSSARY = ['UC-001', 'getGlossary'] as const

const key = (uc: string, operation: string, name: string): ExampleKey => ({ uc, operation, case: name })
const health = (name = 'ok') => key(...HEALTH, name)
const plans = (name: string) => key(...PLANS, name)

/** 実例 1 件の判定を確かめる。 */
const expectVerdict = (run: ContractRunResult, k: ExampleKey, verdict: 'pass' | 'fail') => {
  expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()
  const v = verdictOf(run, k)
  expect(v, `${keyOf(k)} が結果に挙がっていない:\n${tailOf(run)}`).toBeDefined()
  expect(v?.verdict, `${keyOf(k)} の判定（${v?.detail ?? ''}）`).toBe(verdict)
}

afterAll(async () => {
  await removeTemps()
})

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  describe('REQ-567 実例がすべて合ったときだけ通ったことを示す', () => {
    // @covers REQ-567#success-shape
    it('成功例の応答が実装の応答に含まれれば合う（実装の応答の余分な欄は妨げない）', async () => {
      const pass = realExample(...PLANS, 'pass') as { request: unknown; response: { exitCode: number; limits: unknown } }
      const docs = shadowDocs([
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
        // 例の応答を exitCode と limits だけにする。実装の応答は units・topics・stops・warnings も持つ
        {
          uc: 'UC-024',
          operations: { checkUnitPlans: opWith(...PLANS, { pass: { request: pass.request, response: { exitCode: pass.response.exitCode, limits: pass.response.limits } } }) },
        },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expectVerdict(run, health(), 'pass')
      expectVerdict(run, plans('pass'), 'pass')
      expect(run.code, tailOf(run)).toBe(0)
    }, 300_000)

    // @covers REQ-567#failure-name
    it('失敗例に実装が例と同じ断りの種類の名前で断れば合う', async () => {
      const docs = shadowDocs([
        { uc: 'UC-024', operations: { checkUnitPlans: opWith(...PLANS, { unknownLearning: realExample(...PLANS, 'unknownLearning') }) } },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expectVerdict(run, plans('unknownLearning'), 'pass')
      expect(run.code, tailOf(run)).toBe(0)
    }, 300_000)

    // @covers REQ-567#all-examples
    it('確定した契約の自分の持ち物の操作の実例を全件渡し、全件が合えば通る。下書きの契約と他者の形を写した操作の実例は渡さない', async () => {
      const docs = shadowDocs([
        {
          uc: 'UC-024',
          operations: {
            checkUnitPlans: opWith(...PLANS, { unknownLearning: realExample(...PLANS, 'unknownLearning') }),
            // 他者の形を写した操作（owned: false）
            readUnitPlan: opWith('UC-024', 'readUnitPlan', { missing: realExample('UC-024', 'readUnitPlan', 'missing') }, { owned: false }),
          },
        },
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
        // 下書きの契約
        { uc: 'UC-032', status: 'draft', operations: { checkSource: opWith(...SOURCE, { unknownArgument: realExample(...SOURCE, 'unknownArgument') }) } },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expect(run.results, tailOf(run)).not.toBeNull()
      expect((run.results ?? []).map(keyOf).sort()).toEqual([keyOf(health()), keyOf(plans('unknownLearning'))].sort())
      expect(run.results?.every((r) => r.verdict === 'pass'), tailOf(run)).toBe(true)
      expect(run.summary).toEqual({ pass: 2, fail: 0, skip: 0 })
      expect(run.code, tailOf(run)).toBe(0)
    }, 300_000)
  })

  describe('REQ-568 合わない・不備・渡せない実例を挙げて失敗で終える', () => {
    // @covers REQ-568#success-mismatch
    it('成功例に、実装が例の応答を含まない応答を返すか断れば、その実例を挙げて失敗で終える', async () => {
      const pass = realExample(...PLANS, 'pass') as { request: unknown; response: { limits: Record<string, unknown> } }
      const docs = shadowDocs([
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
        {
          uc: 'UC-024',
          operations: {
            checkUnitPlans: opWith(...PLANS, {
              // 実装の応答に含まれない値（門が使う上限は 8）
              pass: { request: pass.request, response: { limits: { ...pass.response.limits, groupTopicsMax: 9 } } },
              // 実装が断る入力を成功例にする
              unknownLearning: { request: realExample(...PLANS, 'unknownLearning').request, response: { exitCode: 0 } },
            }),
          },
        },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expectVerdict(run, health(), 'pass')
      expectVerdict(run, plans('pass'), 'fail')
      expectVerdict(run, plans('unknownLearning'), 'fail')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#failure-mismatch
    it('失敗例に、実装が応答を返すか例と違う名前で断れば、その実例を挙げて失敗で終える', async () => {
      const docs = shadowDocs([
        // 実装が応答を返す入力を失敗例にする
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: { error: 'INTERNAL' } }) } },
        {
          uc: 'UC-024',
          operations: {
            checkUnitPlans: opWith(...PLANS, {
              // 実装は INVALID_INPUT で断る
              unknownLearning: { request: realExample(...PLANS, 'unknownLearning').request, error: 'NOT_FOUND' },
              notQualification: realExample(...PLANS, 'notQualification'),
            }),
          },
        },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expectVerdict(run, health(), 'fail')
      expectVerdict(run, plans('unknownLearning'), 'fail')
      expectVerdict(run, plans('notQualification'), 'pass')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#failure-unnamed
    it('失敗例に、実装が名前を出さずに断れば（終了の状態だけで断る）、その実例を挙げて失敗で終える', async () => {
      // ソースの門だけを、標準出力に何も出さず終了の状態 2 で断る道具に差し替えた影の根
      const root = shadowRoot({
        contracts: [
          { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
          { uc: 'UC-032', operations: { checkSource: opWith(...SOURCE, { unknownArgument: realExample(...SOURCE, 'unknownArgument') }) } },
        ],
        tools: { 'check_source.py': 'import sys\nprint("知らない引数", file=sys.stderr)\nsys.exit(2)\n' },
      })
      const run = await contractRun(['--root', root, '--json'])
      expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()
      expectVerdict(run, health(), 'pass')
      const unnamed = verdictOf(run, key(...SOURCE, 'unknownArgument'))
      expect(unnamed, `名前を出さずに断った実例が挙がっていない:\n${tailOf(run)}`).toBeDefined()
      expect(unnamed?.verdict, '名前を出さずに断った実例が合ったことになっている').not.toBe('pass')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#success-mismatch
    it('成功例に、実装が名前を出さずに止まるか断れば、例の応答が終了の状態か状態の番号だけでも合わない', async () => {
      // 投入の検査（応答が終了の状態 1 だけの成功例 withProblems を持つ）を、標準出力に何も出さず
      // 標準エラーに 1 行だけ出して終了の状態 1 で止まる道具に差し替える。死活確認は成功の状態を 201 にした写しで、
      // 実装の 200 を名前の無い断りにし、応答が状態の番号 200 だけの成功例を当てる
      const health = realExample(...HEALTH, 'ok')
      const root = shadowRoot({
        contracts: [
          { uc: 'UC-001', operations: { getGlossary: opWith(...GLOSSARY, { ok: realExample(...GLOSSARY, 'ok') }) } },
          { uc: 'UC-027', operations: { checkSeed: opWith(...SEED, { withProblems: realExample(...SEED, 'withProblems') }) } },
          {
            uc: 'UC-017',
            operations: {
              getHealth: opWith(...HEALTH, { statusOnly: { request: health.request, response: { status: 200 } } }, { wire: { method: 'GET', path: '/api/health', success: 201 } }),
            },
          },
        ],
        tools: { 'check_seed.py': 'import sys\nprint("止まった", file=sys.stderr)\nsys.exit(1)\n' },
      })
      const run = await contractRun(['--root', root, '--json'])
      expectVerdict(run, key(...GLOSSARY, 'ok'), 'pass')
      expectVerdict(run, key(...SEED, 'withProblems'), 'fail')
      expectVerdict(run, key(...HEALTH, 'statusOnly'), 'fail')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#failure-unnamed
    it('失敗例に、実装が名前を出さずに断れば（HTTP の状態の番号だけで断る）、その実例を挙げて失敗で終える', async () => {
      // 死活確認の成功の状態を 201 にした写しで、実装の 200（本文に断りの名前が無い）を名前の無い断りにする
      const health = realExample(...HEALTH, 'ok')
      const root = shadowRoot({
        contracts: [
          { uc: 'UC-001', operations: { getGlossary: opWith(...GLOSSARY, { ok: realExample(...GLOSSARY, 'ok') }) } },
          {
            uc: 'UC-017',
            operations: {
              getHealth: opWith(...HEALTH, { unnamed: { request: health.request, error: 'NOT_FOUND' } }, { wire: { method: 'GET', path: '/api/health', success: 201 } }),
            },
          },
        ],
        tools: {},
      })
      const run = await contractRun(['--root', root, '--json'])
      expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()
      expectVerdict(run, key(...GLOSSARY, 'ok'), 'pass')
      const unnamed = verdictOf(run, key(...HEALTH, 'unnamed'))
      expect(unnamed, `名前を出さずに断った実例が挙がっていない:\n${tailOf(run)}`).toBeDefined()
      expect(unnamed?.verdict, '名前を出さずに断った実例が合ったことになっている').not.toBe('pass')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#malformed-example
    it('応答も断りの名前も持たない実例があれば、その実例を挙げて失敗で終える（合う実例と混ぜても）', async () => {
      const { request } = realExample(...PLANS, 'unknownLearning')
      const docs = shadowDocs([
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
        { uc: 'UC-024', operations: { checkUnitPlans: opWith(...PLANS, { unknownLearning: { request } }) } },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expectVerdict(run, health(), 'pass')
      expectVerdict(run, plans('unknownLearning'), 'fail')
      expect(run.code, tailOf(run)).not.toBe(0)
    }, 300_000)

    // @covers REQ-568#unreachable
    it('当たる入口の無い操作の実例があれば、通さずにその実例を挙げて失敗で終える', async () => {
      // UC-033 の契約の unknownOperation の例と同じ、入口の無い操作
      const zzz = { ...realOp(...SOURCE), examples: { ok: { request: {}, response: { exitCode: 0 } } } }
      const docs = shadowDocs([
        { uc: 'UC-017', operations: { getHealth: opWith(...HEALTH, { ok: realExample(...HEALTH, 'ok') }) } },
        { uc: 'UC-032', operations: { zzz } },
      ])
      const run = await contractRun(['--docs', docs, '--json'])
      expect(run.code, `入口の無い実例があるのに通った:\n${tailOf(run)}`).not.toBe(0)
      expect(run.code, '止められて終わった').not.toBe(-1)
      expect(verdictOf(run, key('UC-032', 'zzz', 'ok'))?.verdict).not.toBe('pass')
      expect(`${run.stdout}\n${run.stderr}`, '渡せなかった実例（操作 zzz）が挙がっていない').toContain('zzz')
    }, 300_000)

    // @covers REQ-568#unreachable
    it('実装が応えない実例があれば、待ち続けずに失敗で終える', async () => {
      // ソースの門だけを、応えずに居座る道具に差し替えた影の根
      const root = shadowRoot({
        contracts: [{ uc: 'UC-032', operations: { checkSource: opWith(...SOURCE, { unknownArgument: realExample(...SOURCE, 'unknownArgument') }) } }],
        tools: { 'check_source.py': 'import time\ntime.sleep(60)\n' },
      })
      const run = await contractRun(['--root', root, '--json', '--timeout', '10'], { limitMs: 50_000 })
      expect(run.code, `応えない実例を待ち続けた（${run.seconds} 秒）`).not.toBe(-1)
      expect(run.code, `応えない実例があるのに通った:\n${tailOf(run)}`).not.toBe(0)
      expect(verdictOf(run, key(...SOURCE, 'unknownArgument'))?.verdict).not.toBe('pass')
    }, 120_000)
  })

  describe('REQ-570 各実例をその前提の状態を用意して回し、ほかの実例と回す順で結果を変えない', () => {
    /** 本物の契約の、成功例と失敗例で入力が同じ組（片方が応答と名前の両方を持つ実例は除く）。 */
    /** 本物の契約の UC-004・UC-010・UC-024 を契約の順に回した 1 回の結果。同じ入力の組のテストと、順のテストの「ほかの実例のあとに回したとき」が共に使う（同じ実行を 2 度回さない）。 */
    const PREMISE_UCS = ['UC-004', 'UC-010', 'UC-024']
    let premiseRun: Promise<ContractRunResult> | undefined
    const inContractOrder = () => (premiseRun ??= contractRun([...PREMISE_UCS.flatMap((uc) => ['--uc', uc]), '--json']))

    const sameRequestPairs = (uc: string) => {
      const c = CONTRACTS.find((x) => x.uc === uc)
      if (!c) throw new Error(`${uc} の契約が無い`)
      return Object.entries(c.operations).flatMap(([op, o]) => {
        const ex = Object.entries(o.examples ?? {})
        const oks = ex.filter(([, e]) => e.response !== undefined && e.error === undefined)
        const errs = ex.filter(([, e]) => e.error !== undefined && e.response === undefined)
        return oks.flatMap(([a, ea]) =>
          errs
            .filter(([, eb]) => JSON.stringify(ea.request ?? null) === JSON.stringify(eb.request ?? null))
            .map(([b]) => [key(uc, op, a), key(uc, op, b)] as const),
        )
      })
    }

    // @covers REQ-570#same-request-different-premise
    it('同じ入力で成功例と失敗例が並ぶ操作（学び側の API・端末の記憶・道具）で、どちらも例どおりに応える', async () => {
      const pairs = PREMISE_UCS.flatMap(sameRequestPairs)
      for (const uc of PREMISE_UCS) expect(pairs.some(([a]) => a.uc === uc), `${uc} に同じ入力の組が無い`).toBe(true)
      const run = await inContractOrder()
      for (const [ok, err] of pairs) {
        expectVerdict(run, ok, 'pass')
        expectVerdict(run, err, 'pass')
      }
    }, 300_000)

    // @covers REQ-570#order-independent
    it('実例を 1 件だけ回したとき、ほかの実例のあとに回したとき、順を入れ替えたときで結果が同じ', async () => {
      const uc = 'UC-004'
      const ops = CONTRACTS.find((c) => c.uc === uc)?.operations ?? {}
      const names = Object.keys(ops)
      const reversed = Object.fromEntries(
        [...names].reverse().map((op) => [op, opWith(uc, op, Object.fromEntries(Object.entries(ops[op].examples ?? {}).reverse()))]),
      )
      const outcome = (run: ContractRunResult, k: ExampleKey) => {
        const v = verdictOf(run, k)
        return v === undefined ? '(無し)' : `${v.verdict} ${v.detail ?? ''}`
      }
      // 契約の順（ほかの UC の実例と並べて回した結果）
      const inOrder = await inContractOrder()
      const inReverse = await contractRun(['--docs', shadowDocs([{ uc, operations: reversed }]), '--json'])
      expect(inOrder.results, tailOf(inOrder)).not.toBeNull()
      expect(inReverse.results, tailOf(inReverse)).not.toBeNull()
      const all = names.flatMap((op) => Object.keys(ops[op].examples ?? {}).map((n) => key(uc, op, n)))
      for (const k of all) {
        expect(outcome(inOrder, k), `${keyOf(k)} が検査されていない`).not.toMatch(/^skip|^\(無し\)/)
        expect(outcome(inReverse, k), `${keyOf(k)} の結果が順を入れ替えると変わる`).toBe(outcome(inOrder, k))
      }
      // 前のテストの状態で結果の変わりうる操作（終える・結果を見る）の実例を 1 件ずつ回す
      for (const op of ['finishSession', 'getSessionResult']) {
        for (const n of Object.keys(ops[op].examples ?? {})) {
          const k = key(uc, op, n)
          const alone = await contractRun(['--docs', shadowDocs([{ uc, operations: { [op]: opWith(uc, op, { [n]: realExample(uc, op, n) }) } }]), '--json'])
          expect(outcome(alone, k), `${keyOf(k)} の結果が 1 件だけ回すと変わる`).toBe(outcome(inOrder, k))
        }
      }
    }, 600_000)

    // @covers REQ-570#premise-identity
    it('本人や権限を前提とする実例（学び側の本人・まなびばの管理者と管理者でない本人）で、前提の本人と権限が用意されて例どおりに応える', async () => {
      const ucs = ['UC-007', 'UC-011', 'UC-014']
      const targets = ucs.flatMap((uc) => {
        const c = CONTRACTS.find((x) => x.uc === uc && x.status === 'fixed')
        return Object.entries(c?.operations ?? {})
          .filter(([, o]) => o.owned !== false && o.auth !== undefined && o.auth !== 'none')
          .flatMap(([op, o]) => Object.keys(o.examples ?? {}).map((n) => key(uc, op, n)))
      })
      expect(targets.length, '本人や権限を前提とする実例が無い').toBeGreaterThan(0)
      const run = await contractRun([...ucs.flatMap((uc) => ['--uc', uc]), '--json'])
      for (const k of targets) expectVerdict(run, k, 'pass')
    }, 300_000)
  })
})

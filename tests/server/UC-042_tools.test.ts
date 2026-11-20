import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { LEARNINGS, ROOT, type Shadow39, jsonFiles, outOf, ownLearning, readJson, removeShadows, run42, shadow42, snapshot } from './UC-042_fixture'

/** UC-042 書き手と担当に渡す束・図を付ける論点・教材の手入れ・学びの追加の道具の境界（入口は CLAUDE.md の「道具を回す操作」の行）。
 *  道具は影の根（UC-042_fixture.ts）で、OS の囲いの中で回す。書き出しは影の根の中の出力先へ向け、学びの置き場の原本は書き換えない。
 *  配備先の一覧の値は表示しない（比べるのは鍵と真偽だけ）。 */

vi.setConfig({ testTimeout: 300_000 })

afterAll(async () => {
  await removeShadows()
})

type Json = Record<string, any>

/** ip の論点（id と問題数）。 */
const IP_TOPICS = (readJson(join(ROOT, 'data', 'ip', 'topics.json')).topics as Json[]).map((t) => ({ id: t.id as number, count: t.question_count as number }))
/** 問題を持つ論点を n 個（id の順）。 */
const topicsWithQuestions = (n: number) => IP_TOPICS.filter((t) => t.count > 0).slice(0, n)
/** 問題数がどれも違う論点を n 個（id の順に選ぶ）。 */
const topicsWithDistinctCounts = (n: number) => {
  const seen = new Set<number>()
  const out: typeof IP_TOPICS = []
  for (const t of IP_TOPICS) if (t.count > 0 && !seen.has(t.count)) (seen.add(t.count), out.push(t))
  return out.slice(0, n)
}
const topicsOf = (files: string[]) => files.flatMap((f) => readJson(f).topics as Json[])

describe('UC-042 書き手と担当に渡す束を作り、教材の手入れと学びの追加を道具で回す', () => {
  describe('解ける度合いの確かめの束は、正解を伏せた過去問と教材だけを、指定した論点の数ずつ束にする（REQ-642）', () => {
    const build = async () => {
      const s = shadow42('answerability')
      const ids = topicsWithQuestions(7).map((t) => t.id)
      const r = await run42(s, 'build_answerability_bundles.py', ['--data', 'data/ip', '--out', 'out/ans', '--size', '3', '--only', ...ids.map(String)])
      return { s, ids, r, files: jsonFiles(s.path('out/ans')) }
    }

    // @covers REQ-642#bundled-by-size
    it('指定した論点の数ずつ束にし、指定した論点がちょうど 1 回ずつ入る', async () => {
      const { ids, r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      expect(files.map((f) => (readJson(f).topics as Json[]).length)).toEqual([3, 3, 1])
      expect(topicsOf(files).map((t) => t.topic_id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
    })

    // @covers REQ-642#answers-hidden
    it('束の過去問は正解を持たない', async () => {
      const { r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      const keys = new Set(topicsOf(files).flatMap((t) => (t.questions as Json[]).flatMap((q) => Object.keys(q))))
      expect([...keys].filter((k) => /answer|correct/i.test(k)), '正解の欄がある').toEqual([])
    })

    // @covers REQ-642#material-given
    it('束の論点は、その論点の教材（短い説明と詳しい解説）と過去問を持つ', async () => {
      const { r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      for (const t of topicsOf(files)) {
        expect(typeof t.material?.explanation, `論点 ${t.topic_id} の短い説明`).toBe('string')
        expect(typeof t.material?.detail, `論点 ${t.topic_id} の詳しい解説`).toBe('string')
        expect((t.questions as Json[]).length, `論点 ${t.topic_id} の過去問`).toBeGreaterThan(0)
      }
    })
  })

  describe('問題解説の束は、論点ごとに教材と過去問を束にし、束の一覧も書き出す（REQ-643）', () => {
    const build = async () => {
      const s = shadow42('explanation')
      const ids = topicsWithQuestions(3).map((t) => t.id)
      const r = await run42(s, 'build_explanation_bundles.py', ['--data', 'data/ip', '--out', 'out/expl', '--topics-per-bundle', '2', '--only', ...ids.map(String)])
      const files = jsonFiles(s.path('out/expl')).filter((f) => !f.endsWith('/index.json'))
      return { s, ids, r, files }
    }

    // @covers REQ-643#topic-material-and-questions
    it('論点ごとに、教材（短い説明と詳しい解説）とその論点の過去問を束にして書き出す', async () => {
      const { ids, r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      const topics = topicsOf(files)
      expect(topics.map((t) => t.topic_id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
      for (const t of topics) {
        expect(typeof t.explanation, `論点 ${t.topic_id} の短い説明`).toBe('string')
        expect(typeof t.detail, `論点 ${t.topic_id} の詳しい解説`).toBe('string')
        expect((t.questions as Json[]).length, `論点 ${t.topic_id} の過去問`).toBeGreaterThan(0)
      }
    })

    // @covers REQ-643#bundle-index-written
    it('束の一覧を書き出し、一覧の論点は書き出した束の論点と同じ', async () => {
      const { s, r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      expect(existsSync(s.path('out/expl/index.json')), '束の一覧が無い').toBe(true)
      const index = readJson(s.path('out/expl/index.json')).bundles as Json[]
      expect(index.flatMap((b) => b.topic_ids as number[]).sort((a, b) => a - b)).toEqual(
        topicsOf(files)
          .map((t) => t.topic_id as number)
          .sort((a, b) => a - b),
      )
      expect(index.length).toBe(files.length)
    })
  })

  describe('教材の束は、論点を出題頻度の降順に詰め、今の教材と過去問を持つ（REQ-644）', () => {
    const build = async () => {
      const s = shadow42('material')
      const chosen = topicsWithDistinctCounts(5)
      const r = await run42(s, 'build_material_bundles.py', ['--data', 'data/ip', '--out', 'out/mat', '--only', ...chosen.map((t) => String(t.id))])
      return { chosen, r, files: jsonFiles(s.path('out/mat')) }
    }

    // @covers REQ-644#frequency-descending
    it('論点を出題頻度（論点の問題数）の降順に詰める', async () => {
      const { chosen, r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      const order = topicsOf(files).map((t) => t.topic_id as number)
      const expected = [...chosen].sort((a, b) => b.count - a.count).map((t) => t.id)
      expect(order).toEqual(expected)
    })

    // @covers REQ-644#current-material-and-questions
    it('各論点の今の教材と、その論点が出題された過去問を持つ', async () => {
      const { r, files } = await build()
      expect(r.code, outOf(r)).toBe(0)
      const topics = topicsOf(files)
      expect(topics.length).toBeGreaterThan(0)
      for (const t of topics) {
        expect(typeof t.current?.explanation, `論点 ${t.topic_id} の今の教材`).toBe('string')
        expect((t.questions as Json[]).length, `論点 ${t.topic_id} の過去問`).toBeGreaterThan(0)
      }
    })
  })

  describe('資格対策の学びで、図を付ける論点を優先度の順に示す（REQ-645）', () => {
    const makePlan = async () => {
      const s = shadow42('plan-material')
      mkdirSync(s.path('out'), { recursive: true })
      const r = await run42(s, 'plan_material_figures.py', ['--data', 'data/ap', '--out', 'out/plan.json'])
      return { r, plan: existsSync(s.path('out/plan.json')) ? readJson(s.path('out/plan.json')) : null }
    }

    // @covers REQ-645#priority-order
    it('図を付ける論点を、優先度の降順に示す', async () => {
      const { r, plan } = await makePlan()
      expect(r.code, outOf(r)).toBe(0)
      const p = (plan?.figures as Json[]).map((f) => f.priority as number)
      expect(p.length).toBeGreaterThan(0)
      expect(p).toEqual([...p].sort((a, b) => b - a))
    })

    // @covers REQ-645#excluded-types-separated
    it('図の対象から外す型の論点は、図を付ける論点に入らない', async () => {
      const { r, plan } = await makePlan()
      expect(r.code, outOf(r)).toBe(0)
      const figureIds = new Set((plan?.figures as Json[]).map((f) => f.topic_id))
      const excluded = (plan?.tables as Json[]) ?? []
      expect(excluded.length, '仕込み: 外した論点が無い').toBeGreaterThan(0)
      expect(excluded.filter((t) => figureIds.has(t.topic_id)).map((t) => t.topic_id)).toEqual([])
    })
  })

  describe('ロードマップ型の学びで、図を付ける単位を優先度の順に書き出す（REQ-646）', () => {
    const makePlan = async () => {
      const s = shadow42('plan-roadmap')
      mkdirSync(s.path('out'), { recursive: true })
      const r = await run42(s, 'plan_roadmap_figures.py', ['--data', 'data/itc', '--out', 'out/plan.json'])
      return { r, plan: existsSync(s.path('out/plan.json')) ? readJson(s.path('out/plan.json')) : null }
    }

    // @covers REQ-646#priority-order
    it('図を付ける単位を、優先度の降順に書き出す', async () => {
      const { r, plan } = await makePlan()
      expect(r.code, outOf(r)).toBe(0)
      const p = (plan?.figures as Json[]).map((f) => f.priority as number)
      expect(p.length).toBeGreaterThan(0)
      expect(p).toEqual([...p].sort((a, b) => b - a))
    })

    // @covers REQ-646#no-benefit-excluded
    it('図の効きの無い単位は書き出さない', async () => {
      const { r, plan } = await makePlan()
      expect(r.code, outOf(r)).toBe(0)
      expect((plan?.figures as Json[]).filter((f) => !(Number(f.benefit) > 0)).map((f) => f.topic_id)).toEqual([])
    })
  })

  describe('禁じた語を一覧し、何も書き換えない（REQ-647）', () => {
    const WORD = 'ゾワゾワ語'
    const scan = async () => {
      const s = shadow42('scan')
      ownLearning(s, 'msg')
      const file = jsonFiles(s.path('data/msg/materials'))[0]
      const body = readJson(file)
      const m = (body.materials as Json[])[0]
      m.detail = `${m.detail}\nここに${WORD}がある。`
      writeFileSync(file, JSON.stringify(body, null, 2))
      const before = snapshot(s.path('data/msg'))
      const r = await run42(s, 'scan_words.py', ['--data', 'data/msg', '--rx', WORD])
      return { s, r, m, before }
    }

    // @covers REQ-647#matches-shown
    it('渡した語の型に当たる教材の箇所を、論点とともに示す', async () => {
      const { r, m } = await scan()
      expect(r.code, outOf(r)).toBe(0)
      expect(r.out).toContain(WORD)
      expect(r.out.includes(String(m.topic_id)) || r.out.includes(String(m.term)), `論点（${m.topic_id}）を示していない:\n${outOf(r)}`).toBe(true)
    })

    // @covers REQ-647#nothing-written
    it('学びの置き場を何も書き換えない', async () => {
      const { s, r, before } = await scan()
      expect(r.code, outOf(r)).toBe(0)
      expect(snapshot(s.path('data/msg'))).toEqual(before)
    })
  })

  describe('読み直しの指摘を集計し、何も書き換えず、指摘が無ければ失敗で終える（REQ-648）', () => {
    // @covers REQ-648#summary-shown
    it('学びの読み直しの指摘を集計して示し、成功で終える', async () => {
      // 指摘の数が決まった読み直しを置く: 型「役割分担」2 件・「硬い語」1 件、重さ「中」2 件・「低」1 件
      const s = shadow42('review')
      ownLearning(s, 'mkt')
      const dir = s.path('data/mkt/review')
      const sample = readJson(join(dir, 'bundle_01.json'))
      const findings = (sample.findings as Json[]).slice(0, 3)
      expect(findings.length, '仕込み: 読み直しの指摘が 3 件に満たない').toBe(3)
      const planted = [['役割分担', '中'], ['役割分担', '中'], ['硬い語', '低']]
      planted.forEach(([kind, severity], i) => Object.assign(findings[i], { kind, severity }))
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bundle_01.json'), JSON.stringify({ ...sample, findings }, null, 2))
      const r = await run42(s, 'summarize_review.py', ['--key', 'mkt'])
      expect(r.code, outOf(r)).toBe(0)
      const lines = r.out.split('\n')
      const counted = (label: string, n: number) => lines.some((l) => l.includes(label) && new RegExp(`(?<!\\d)${n}(?!\\d)`).test(l))
      expect(lines.some((l) => /(^|[^a-z])mkt([^a-z]|$)/.test(l) && /(?<!\d)3(?!\d)/.test(l)), `学びごとの件数の行が無い:\n${outOf(r)}`).toBe(true)
      expect(counted('役割分担', 2) && counted('硬い語', 1), `型ごとの件数の行が無い:\n${outOf(r)}`).toBe(true)
      expect(counted('中', 2) && counted('低', 1), `重さごとの件数の行が無い:\n${outOf(r)}`).toBe(true)
    })

    // @covers REQ-648#nothing-written
    it('何も書き換えない', async () => {
      const s = shadow42('review-nowrite')
      ownLearning(s, 'mkt')
      const before = snapshot(s.path('data/mkt'))
      const r = await run42(s, 'summarize_review.py', ['--key', 'mkt'])
      expect(r.code, outOf(r)).toBe(0)
      expect(snapshot(s.path('data/mkt'))).toEqual(before)
    })

    // @covers REQ-648#no-review-fails
    it('集計する指摘が無ければ、その旨を示して失敗で終える', async () => {
      const s = shadow42('review-none')
      ownLearning(s, 'mkt')
      rmSync(s.path('data/mkt/review'), { recursive: true, force: true })
      const r = await run42(s, 'summarize_review.py', ['--key', 'mkt'])
      expect(r.code, outOf(r)).not.toBe(0)
      expect(r.out.trim().length, 'その旨を示していない').toBeGreaterThan(0)
    })
  })

  describe('数字と単位の間の空白を詰めて数を示し、数えるだけの指定では書き換えない（REQ-649）', () => {
    const PLANTED = ['10 分', '3 個', '5 MB', '80 %']
    const plant = () => {
      const s = shadow42('tighten')
      ownLearning(s, 'mkt')
      const file = jsonFiles(s.path('data/mkt/materials'))[0]
      const body = readJson(file)
      const m = (body.materials as Json[])[0]
      m.detail = `${m.detail}\n${PLANTED.join('、')}の例。`
      writeFileSync(file, JSON.stringify(body, null, 2))
      return { s, file }
    }
    /** 置き場の JSON の文字列の値に含まれる空白（半角・全角）の数。 */
    const spacesIn = (dir: string) => {
      const walk = (v: unknown): number =>
        typeof v === 'string' ? (v.match(/[ \u3000]/g) ?? []).length : v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + walk(x), 0) : 0
      const files = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith('.json') ? [join(d, e.name)] : []))
      return files(dir).reduce((n, f) => n + walk(readJson(f)), 0)
    }
    const countOf = (out: string) => Math.max(0, ...[...out.matchAll(/(\d+)\s*箇所/g)].map((m) => Number(m[1])))

    // @covers REQ-649#tightened-and-counted
    it('数字と単位の間の空白を詰め、詰めた数を示す', async () => {
      const { s, file } = plant()
      const spaces = spacesIn(s.path('data/mkt'))
      const r = await run42(s, 'tighten_number_units.py', ['--data', 'data/mkt'])
      expect(r.code, outOf(r)).toBe(0)
      const text = readFileSync(file, 'utf8')
      const tightened = PLANTED.filter((p) => !text.includes(p))
      expect(tightened.length, `足した空白が 1 つも詰まっていない:\n${outOf(r)}`).toBeGreaterThan(0)
      // 示した数（「n 箇所」）は、学びの置き場の文字列から実際に消えた空白の数と合う
      expect(countOf(r.out), `詰めた数が実際に詰まった数と合わない:\n${outOf(r)}`).toBe(spaces - spacesIn(s.path('data/mkt')))
    })

    // @covers REQ-649#dry-run-unchanged
    it('数えるだけの指定では、数を示して何も書き換えない', async () => {
      const { s } = plant()
      const before = snapshot(s.path('data/mkt'))
      const r = await run42(s, 'tighten_number_units.py', ['--data', 'data/mkt', '--dry-run'])
      expect(r.code, outOf(r)).toBe(0)
      expect(snapshot(s.path('data/mkt'))).toEqual(before)
      expect(countOf(r.out), `足した空白を数えていない:\n${outOf(r)}`).toBeGreaterThan(0)
    })
  })

  describe('新しい学びを登録する（REQ-650・REQ-651）と、登録簿の整合を確かめる（REQ-654）', () => {
    const REG = 'src/shared/targets.json'
    const PROJ = 'scripts/pages_projects.json'
    const read = (s: Shadow39, rel: string) => JSON.parse(readFileSync(s.path(rel), 'utf8')) as Json
    const ROADMAP_ARGS = ['zzq', '--kind', 'roadmap', '--name', '仕込みの学び', '--target-name', '仕込みの題材', '--fields', '基礎,応用', '--per-day', '3', '--days', '14']
    const EXAM_ARGS = (ratio: string, size = '60') => [
      'zzx',
      '--kind',
      'exam',
      '--name',
      '仕込みの試験',
      '--target-name',
      '仕込みの資格',
      '--exam-name',
      '仕込み試験 科目A',
      '--fields',
      'テクノロジ系,マネジメント系,ストラテジ系',
      '--mock-size',
      size,
      '--mock-minutes',
      '90',
      '--field-ratio',
      ratio,
      '--pass-rule',
      '総合で 6 割',
    ]
    /** 手元の秘密のファイルの代わり（中身の無い物）を、登録簿の学びごとに置く。 */
    const fakeEnv = (s: Shadow39, keys: string[]) => {
      for (const k of keys) writeFileSync(s.path(`.env.${k}`), 'UC042_PLACEHOLDER=1\n')
    }

    // @covers REQ-650#roadmap-registered
    it('ロードマップ型の学びを登録すると、登録簿・配備先の一覧・手元の配備の設定と学びの置き場の骨組みに足す', async () => {
      const s = shadow42('new-roadmap')
      const r = await run42(s, 'new_target.py', ROADMAP_ARGS)
      expect(r.code, outOf(r)).toBe(0)
      expect(read(s, REG).zzq, '登録簿に無い').toBeDefined()
      expect(read(s, PROJ).zzq, '配備先の一覧に無い').toBeDefined()
      expect(readFileSync(s.path('wrangler.jsonc'), 'utf8')).toContain('"zzq"')
      expect(existsSync(s.path('data/zzq')), '学びの置き場の骨組みが無い').toBe(true)
    })

    // @covers REQ-650#exam-registered
    it('資格型の学びを登録すると、登録簿・配備先の一覧・手元の配備の設定に足す', async () => {
      const s = shadow42('new-exam')
      const r = await run42(s, 'new_target.py', EXAM_ARGS('テクノロジ系=38,マネジメント系=7,ストラテジ系=15'))
      expect(r.code, outOf(r)).toBe(0)
      expect(read(s, REG).zzx, '登録簿に無い').toBeDefined()
      expect(read(s, PROJ).zzx, '配備先の一覧に無い').toBeDefined()
      expect(readFileSync(s.path('wrangler.jsonc'), 'utf8')).toContain('"zzx"')
    })

    // @covers REQ-650#existing-untouched
    it('既にある学びの登録簿と配備先の一覧の中身は変わらない', async () => {
      const s = shadow42('new-untouched')
      const reg = read(s, REG)
      const proj = read(s, PROJ)
      const r = await run42(s, 'new_target.py', ROADMAP_ARGS)
      expect(r.code, outOf(r)).toBe(0)
      const reg2 = read(s, REG)
      const proj2 = read(s, PROJ)
      const changed = (a: Json, b: Json) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      expect(changed(reg, reg2), '登録簿の既にある学びが変わった').toEqual([])
      expect(changed(proj, proj2), '配備先の一覧の既にある学びが変わった').toEqual([])
    })

    // @covers REQ-650#no-signup-code
    it('学び側での登録の合言葉は作らず、配備先の一覧にも書かない', async () => {
      const s = shadow42('new-nocode')
      const r = await run42(s, 'new_target.py', ROADMAP_ARGS)
      expect(r.code, outOf(r)).toBe(0)
      const added = read(s, PROJ).zzq as Json
      expect(Object.keys(added ?? {}).filter((k) => /signup|code/i.test(k)), '合言葉の項目を書いた').toEqual([])
    })

    // @covers REQ-651#ratio-field-mismatch
    it('分野の比率に分野の一覧に無い分野があると、理由を示して失敗で終え、登録簿を書き換えない', async () => {
      const s = shadow42('new-ratio-field')
      const before = readFileSync(s.path(REG), 'utf8')
      const r = await run42(s, 'new_target.py', EXAM_ARGS('テクノロジ系=38,マネジメント系=7,無い分野=15'))
      expect(r.code, outOf(r)).not.toBe(0)
      expect(r.out.trim().length).toBeGreaterThan(0)
      expect(readFileSync(s.path(REG), 'utf8')).toBe(before)
    })

    // @covers REQ-651#ratio-sum-mismatch
    it('分野の比率の合計が問題数と合わないと、理由を示して失敗で終え、登録簿を書き換えない', async () => {
      const s = shadow42('new-ratio-sum')
      const before = readFileSync(s.path(REG), 'utf8')
      const r = await run42(s, 'new_target.py', EXAM_ARGS('テクノロジ系=30,マネジメント系=7,ストラテジ系=15'))
      expect(r.code, outOf(r)).not.toBe(0)
      expect(r.out.trim().length).toBeGreaterThan(0)
      expect(readFileSync(s.path(REG), 'utf8')).toBe(before)
    })

    /** 配備先の一覧の、合言葉の項目を外す（with に挙げた学びにだけ、偽の合言葉を残す）。 */
    const withCodes = (s: Shadow39, keep: string[]) => {
      const proj = read(s, PROJ)
      for (const [k, v] of Object.entries(proj)) {
        if (!v || typeof v !== 'object') continue
        for (const f of Object.keys(v)) if (/signup/i.test(f)) delete (v as Json)[f]
        if (keep.includes(k)) (v as Json).signup_code = 'uc042fakecode'
      }
      writeFileSync(s.path(PROJ), JSON.stringify(proj, null, 2))
    }

    // @covers REQ-654#signup-code-listed
    it('配備先の一覧のどれかの学びが合言葉を持つと、その学びを挙げて失敗で終える', async () => {
      const s = shadow42('check-code')
      fakeEnv(s, LEARNINGS)
      const target = LEARNINGS.find((k) => read(s, PROJ)[k])!
      withCodes(s, [target])
      const r = await run42(s, 'new_target.py', ['--check'])
      expect(r.code, outOf(r)).not.toBe(0)
      expect(r.out).toContain(target)
    })

    // @covers REQ-654#no-code-passes
    it('どの学びも合言葉を持たず、ほかが整っていれば、成功で終える', async () => {
      const s = shadow42('check-nocode')
      fakeEnv(s, LEARNINGS)
      withCodes(s, [])
      const r = await run42(s, 'new_target.py', ['--check'])
      expect(r.code, outOf(r)).toBe(0)
    })
  })
})


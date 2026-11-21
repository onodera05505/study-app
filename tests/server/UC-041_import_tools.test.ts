import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  A, LOCAL_NO_PROXY, apAnswerPdf, apSite, crashed, extractedQ, ipAnswerPdf, ipSite, localDistributor, refusingProxy, ipSyllabusPages, makePdf, pngSize, removeTemps, shadow41, syllabusPdf,
  type Run, type Shadow41, type SylPage,
} from './UC-041_fixture'

/** UC-041 過去問の回を取り込む道具 11 本の境界。仕込みは影の根（UC-041_fixture.ts）と、テストの中で作る小さな PDF と JSON。
 *  外へ取りに行く 2 本は、環境の代理を手元の偽の配布先に向けて回す（本物の配布先には届かない）。 */

vi.setConfig({ testTimeout: 240_000 })
afterAll(removeTemps)

const ok = (r: Run) => {
  expect(crashed(r), r.out.slice(-800)).toBe(false)
  expect(r.code, r.out.slice(-800)).toBe(0)
}
/** 理由を示して失敗で終えた（名前の無い例外で止まらず、0 でない終了の状態で、needle を含む文を出した）。 */
const failedWith = (r: Run, needle: string) => {
  expect(crashed(r), `名前の無い例外で止まった: ${r.out.slice(-600)}`).toBe(false)
  expect(r.code, r.out.slice(-600)).not.toBe(0)
  expect(r.out.includes(needle), `理由に ${needle} が無い: ${r.out.slice(-600)}`).toBe(true)
}
const json = (s: Shadow41, rel: string) => JSON.parse(s.read(rel) ?? 'null')

describe('UC-041 過去問の回を取り込む', () => {
  describe('IT パスポートの PDF は、取りに行く先（指定しなければ公開の配布の場所）から取り、既にあるファイルは取り直さない（REQ-630）', () => {
    // @covers REQ-630#asks-public-distributor
    it('取りに行く先を指定しなければ、公開の配布の場所に取りに行き、ほかの場所には行かない（囲いが断った宛先で見る）', async () => {
      const proxy = await refusingProxy()
      try {
        await shadow41().run('fetch_pdfs.py', ['--out', 'data/ip/pdfs'], proxy.env)
        expect(proxy.refused.length, '取りに行っていない').toBeGreaterThan(0)
        expect(proxy.refused.every((u) => u.startsWith('https://www3.jitec.ipa.go.jp')), `ほかの場所に行った: ${proxy.refused.join(',')}`).toBe(true)
      } finally {
        await proxy.close()
      }
    })
    // @covers REQ-630#given-origin
    it('取りに行く先に手元の偽の配布先を指定すると、そこから回ごとの問題冊子と解答例を取る', async () => {
      const site = ipSite(['2024r06', '2023r05'])
      const d = await localDistributor(site)
      try {
        const s = shadow41()
        ok(await s.run('fetch_pdfs.py', ['--origin', d.origin, '--out', 'out/pdfs'], LOCAL_NO_PROXY))
        const names = ['2023r05_ip_ans.pdf', '2023r05_ip_qs.pdf', '2024r06_ip_ans.pdf', '2024r06_ip_qs.pdf']
        expect(s.list('out/pdfs')).toEqual(names)
        for (const n of names) {
          expect(Buffer.compare(readFileSync(s.path(`out/pdfs/${n}`)), site[`/JitesCbt/html/openinfo/pdf/questions/${n}`].body as Buffer), `${n} の中身が違う`).toBe(0)
        }
      } finally {
        await d.close()
      }
    })
    // @covers REQ-630#existing-not-refetched
    it('既にあるファイルは取り直さず、無いファイルだけを取る', async () => {
      const d = await localDistributor(ipSite(['2024r06']))
      try {
        const s = shadow41()
        s.write('out/pdfs/2024r06_ip_qs.pdf', '既に取った問題冊子')
        ok(await s.run('fetch_pdfs.py', ['--origin', d.origin, '--out', 'out/pdfs'], LOCAL_NO_PROXY))
        expect(d.requests.some((p) => p.endsWith('/2024r06_ip_qs.pdf')), '既にあるファイルを取り直した').toBe(false)
        expect(s.read('out/pdfs/2024r06_ip_qs.pdf')).toBe('既に取った問題冊子')
        expect(s.list('out/pdfs')).toEqual(['2024r06_ip_ans.pdf', '2024r06_ip_qs.pdf'])
      } finally {
        await d.close()
      }
    })
  })

  describe('応用情報・基本情報の PDF は、取りに行く先（指定しなければ公開の場所）の年度ごとのページから取る（REQ-631）', () => {
    const YEARS = { '2024r06': ['2024r06a', '2024r06h'], '2023r05': ['2023r05a', '2023r05h'] }
    // @covers REQ-631#asks-public-distributor
    it('取りに行く先を指定しなければ、応用情報の公開のページに取りに行き、ほかの場所には行かない（囲いが断った宛先で見る）', async () => {
      const proxy = await refusingProxy()
      try {
        await shadow41().run('fetch_pdfs_ap.py', ['--exam', 'ap', '--recent', '1', '--out', 'data/ap/pdfs'], proxy.env)
        expect(proxy.refused.length, '取りに行っていない').toBeGreaterThan(0)
        expect(proxy.refused.every((u) => u.startsWith('https://www.ipa.go.jp')), `ほかの場所に行った: ${proxy.refused.join(',')}`).toBe(true)
      } finally {
        await proxy.close()
      }
    })
    // @covers REQ-631#given-origin-recent
    it('取りに行く先を指定し、新しい方から 2 回と指定すると、新しい 2 回の問題冊子と解答例だけを取る', async () => {
      const d = await localDistributor(apSite(YEARS))
      try {
        const s = shadow41()
        ok(await s.run('fetch_pdfs_ap.py', ['--exam', 'ap', '--recent', '2', '--origin', d.origin, '--out', 'out/pdfs'], LOCAL_NO_PROXY))
        expect(s.list('out/pdfs')).toEqual(['2024r06a_ap_am_ans.pdf', '2024r06a_ap_am_qs.pdf', '2024r06h_ap_am_ans.pdf', '2024r06h_ap_am_qs.pdf'])
      } finally {
        await d.close()
      }
    })
    // @covers REQ-631#given-origin-exams
    it('取りに行く先を指定し、回を指定すると、その回の問題冊子と解答例だけを取る', async () => {
      const d = await localDistributor(apSite(YEARS))
      try {
        const s = shadow41()
        ok(await s.run('fetch_pdfs_ap.py', ['--exam', 'ap', '--exams', '2023r05h', '--origin', d.origin, '--out', 'out/pdfs'], LOCAL_NO_PROXY))
        expect(s.list('out/pdfs')).toEqual(['2023r05h_ap_am_ans.pdf', '2023r05h_ap_am_qs.pdf'])
      } finally {
        await d.close()
      }
    })
  })

  describe('問題冊子の各ページを、指定した解像度の画像として回ごとの置き場に書き出す（REQ-632）', () => {
    const rendered = once(async () => {
      const s = shadow41()
      makePdf(s.path('data/ip/pdfs/2024r06_ip_qs.pdf'), [['問1 一'], ['問2 二'], ['問3 三']])
      const r = await s.run('render_pages.py', ['2024r06', '--data', 'data/ip', '--out', 'out/pages', '--dpi', '72'])
      return { s, r }
    })
    // @covers REQ-632#each-page
    it('各ページを 1 枚ずつ、回の置き場に画像として書き出す', async () => {
      const { s, r } = await rendered()
      ok(r)
      const files = s.list('out/pages/2024r06').filter((f) => f.endsWith('.png'))
      expect(files.length).toBe(3)
    })
    // @covers REQ-632#resolution
    it('解像度を倍にすると、画像の幅も倍になる', async () => {
      const { s } = await rendered()
      const r2 = await s.run('render_pages.py', ['2024r06', '--data', 'data/ip', '--out', 'out/pages144', '--dpi', '144'])
      ok(r2)
      const w72 = pngSize(s.path(`out/pages/2024r06/${s.list('out/pages/2024r06')[0]}`)).width
      const w144 = pngSize(s.path(`out/pages144/2024r06/${s.list('out/pages144/2024r06')[0]}`)).width
      expect(Math.abs(w72 - 595) <= 2, `72 dpi の幅 ${w72}`).toBe(true)
      expect(Math.abs(w144 - 2 * w72) <= 2, `144 dpi の幅 ${w144}`).toBe(true)
    })
  })

  describe('読み取りの結果を問番号の順に 1 回分にまとめ、表記の揺れを正規化し、異常と食い違いを挙げる（REQ-633）', () => {
    const merge = async (chunks: Record<string, unknown[]>, args: string[] = []) => {
      const s = shadow41()
      for (const [name, qs] of Object.entries(chunks)) s.json(`data/ip/extracted/2024r06/${name}`, { exam: '2024r06', pages: [1, 2], questions: qs })
      const r = await s.run('merge_questions.py', ['2024r06', '--extracted-dir', 'data/ip/extracted', '--out-dir', 'out/questions', ...args])
      return { s, r, out: json(s, 'out/questions/2024r06.json') }
    }
    // @covers REQ-633#number-order
    it('範囲ごとの結果を、問番号の順に 1 回分の問題にまとめる', async () => {
      const { r, out } = await merge({ 'chunk_01.json': [extractedQ(3, 2), extractedQ(1, 1)], 'chunk_02.json': [extractedQ(4, 2), extractedQ(2, 1)] }, ['--count', '4'])
      ok(r)
      expect(out.questions.map((q: { number: number }) => q.number)).toEqual([1, 2, 3, 4])
    })
    // @covers REQ-633#normalized
    it('表記の揺れ（読点の「、」）を「，」にそろえ、正規化しない指定では読み取りのまま残す', async () => {
      const raw = 'aとb、cのうち正しいものはどれか。'
      const normalized = await merge({ 'chunk_01.json': [extractedQ(1, 1, raw)] }, ['--count', '1'])
      ok(normalized.r)
      expect(normalized.out.questions[0].text).toBe('aとb，cのうち正しいものはどれか。')
      const kept = await merge({ 'chunk_01.json': [extractedQ(1, 1, raw)] }, ['--count', '1', '--no-normalize'])
      ok(kept.r)
      expect(kept.out.questions[0].text).toBe(raw)
    })
    // @covers REQ-633#gap-reported
    it('欠けた問番号を挙げる', async () => {
      const { r } = await merge({ 'chunk_01.json': [extractedQ(1, 1), extractedQ(2, 1), extractedQ(4, 2)] }, ['--count', '4'])
      expect(/欠番[^\n]*\b3\b/.test(r.out), `欠けた問 3 を挙げていない: ${r.out.slice(-600)}`).toBe(true)
    })
    // @covers REQ-633#range-conflict-reported
    it('2 つの範囲が同じ問番号を持つ食い違いを挙げる', async () => {
      const { r } = await merge({ 'chunk_01.json': [extractedQ(1, 1), extractedQ(2, 1)], 'chunk_02.json': [extractedQ(2, 2, '別の読み取り'), extractedQ(3, 2)] }, ['--count', '3'])
      expect(/重複[^\n]*\b2\b/.test(r.out), `同じ問番号 2 を挙げていない: ${r.out.slice(-600)}`).toBe(true)
    })
  })

  describe('IT パスポートの解答例から、回ごとの問番号と正解の記号の組を正解表に書き出す（REQ-634）', () => {
    // @covers REQ-634#answer-keys
    it('解答例の 100 問の正解を、回の正解表に書き出す', async () => {
      const s = shadow41()
      ipAnswerPdf(s, 'data/ip/pdfs/2024r06_ip_ans.pdf', (n) => A[(n * 3) % 4])
      const r = await s.run('extract_answer_keys.py', ['--pdf-dir', 'data/ip/pdfs', '--out', 'out/answer_keys.json'])
      ok(r)
      const keys = json(s, 'out/answer_keys.json')['2024r06']
      expect(Object.keys(keys).length).toBe(100)
      for (let n = 1; n <= 100; n++) expect(keys[String(n)], `問${n}`).toBe(A[(n * 3) % 4])
    })
  })

  describe('応用情報・基本情報の解答例から、正解と公式の分野を正解表と分野の表に書き出す（REQ-635）', () => {
    // @covers REQ-635#answer-keys-and-fields
    it('解答例の 80 問の正解と分野（Ｔ・Ｍ・Ｓ）を、正解表と分野の表に書き出す', async () => {
      const s = shadow41()
      const field = (n: number) => (n <= 50 ? 'Ｔ' : n <= 60 ? 'Ｍ' : 'Ｓ')
      apAnswerPdf(s, 'data/ap/pdfs/2024r06h_ap_am_ans.pdf', (n) => A[(n * 3) % 4], field)
      const r = await s.run('extract_answer_keys_ap.py', ['--data', 'data/ap', '--out', 'out/answer_keys.json', '--fields-out', 'out/question_fields.json'])
      ok(r)
      const keys = json(s, 'out/answer_keys.json')['2024r06h']
      const fields = json(s, 'out/question_fields.json')['2024r06h']
      const name = { Ｔ: 'テクノロジ系', Ｍ: 'マネジメント系', Ｓ: 'ストラテジ系' } as Record<string, string>
      for (let n = 1; n <= 80; n++) {
        expect(keys[String(n)], `問${n} の正解`).toBe(A[(n * 3) % 4])
        expect(fields[String(n)], `問${n} の分野`).toBe(name[field(n)])
      }
    })
  })

  describe('IT パスポートのシラバスの階層と用語例を、分類の受け皿に書き出す（REQ-636）', () => {
    // @covers REQ-636#hierarchy-and-terms
    it('分野・大分類・中分類・項目の階層と項目ごとの用語例を書き出す', async () => {
      const s = shadow41()
      const pages = ipSyllabusPages()
      syllabusPdf(s, 'data/ip/syllabus_test.pdf', pages, (i) => `- ${i} - `)
      const r = await s.run('parse_syllabus.py', ['--pdf', 'data/ip/syllabus_test.pdf', '--out', 'out/syllabus.json', '--start-page', '1'])
      ok(r)
      const items = json(s, 'out/syllabus.json').items as Array<Record<string, unknown>>
      expect(items.length).toBe(63)
      for (const p of pages) {
        for (const it of p.items) {
          const got = items.find((x) => x.number === it.no)
          expect(got, `項目 ${it.no}`).toBeDefined()
          expect({ name: got!.name, field: got!.field, major_no: got!.major_no, middle_no: got!.middle_no, terms: got!.terms }).toEqual({
            name: it.name, field: p.field, major_no: p.major[0], middle_no: p.middle[0], terms: it.terms,
          })
        }
      }
    })
  })

  describe('応用情報・基本情報のシラバスの階層と用語例を書き出し、分類の束が読む索引も書き出す（REQ-637）', () => {
    const AP_PAGES: SylPage[] = [
      { field: 'テクノロジ系', major: [1, '基礎理論'], middle: [1, '基礎理論'], items: [{ no: 1, name: '離散数学', terms: ['集合', '論理演算'] }, { no: 2, name: '応用数学', terms: ['確率'] }] },
      { field: 'マネジメント系', major: [5, 'プロジェクトマネジメント'], middle: [14, 'プロジェクトマネジメント'], items: [{ no: 1, name: '計画', terms: ['WBS'] }] },
      { field: 'ストラテジ系', major: [7, 'システム戦略'], middle: [16, 'システム戦略'], items: [{ no: 1, name: '情報システム戦略', terms: ['EA'] }] },
    ]
    const parsed = once(async () => {
      const s = shadow41()
      syllabusPdf(s, 'data/ap/syllabus_ap_ver9_9.pdf', AP_PAGES, (i) => `-${i}- `)
      const r = await s.run('parse_syllabus_ap.py', ['--data', 'data/ap', '--out', 'data/ap/syllabus.json', '--index-out', 'data/ap/syllabus_index.json'])
      return { r, items: (json(s, 'data/ap/syllabus.json')?.items ?? []) as Array<Record<string, unknown>>, index: (json(s, 'data/ap/syllabus_index.json')?.items ?? []) as Array<Record<string, unknown>> }
    })
    // @covers REQ-637#hierarchy-terms-and-index
    it('階層を分類の受け皿に、小分類の一覧を索引に書き出す', async () => {
      const { r, items, index } = await parsed()
      ok(r)
      const expected = AP_PAGES.flatMap((p) => p.items.map((it) => ({ name: it.name, field: p.field, major_no: p.major[0], middle_no: p.middle[0] })))
      expect(items.map((x) => ({ name: x.name, field: x.field, major_no: x.major_no, middle_no: x.middle_no }))).toEqual(expected)
      expect(index.map((x) => ({ name: x.name, field: x.field }))).toEqual(expected.map((e) => ({ name: e.name, field: e.field })))
      expect(index.every((x) => Array.isArray(x.terms) && (x.terms as unknown[]).length > 0), '索引に用語例が無い').toBe(true)
    })
    // @covers REQ-637#no-heading-in-terms
    it('分野が変わるページの切れ目でも、項目の用語例に次の分野の見出しの字を混ぜない', async () => {
      const { items, index } = await parsed()
      const expected = AP_PAGES.flatMap((p) => p.items.map((it) => it.terms))
      expect(items.map((x) => x.terms)).toEqual(expected)
      expect(index.map((x) => x.terms)).toEqual(expected)
    })
  })

  describe('回の問題を指定した数ずつに分け、公式の分野のシラバスの項目だけを添えて束に書き出す（REQ-638）', () => {
    const bundles = once(async () => {
      const s = shadow41()
      const qs = Array.from({ length: 7 }, (_, i) => extractedQ(i + 1, 1))
      s.json('data/ap/questions/2024r06h.json', { exam: '2024r06h', question_count: 7, questions: qs })
      s.json('data/ap/question_fields.json', { '2024r06h': Object.fromEntries(qs.map((q) => [String(q.number), q.number <= 3 ? 'テクノロジ系' : q.number <= 6 ? 'ストラテジ系' : 'マネジメント系'])) })
      s.json('data/ap/syllabus_index.json', {
        items: [
          { number: 1, name: '離散数学', field: 'テクノロジ系', major: '基礎理論', middle: '基礎理論', middle_no: 1, terms: ['集合'] },
          { number: 2, name: '経営', field: 'ストラテジ系', major: '企業', middle: '企業活動', middle_no: 20, terms: ['株主'] },
          { number: 3, name: '計画', field: 'マネジメント系', major: 'PM', middle: 'PM', middle_no: 13, terms: ['WBS'] },
        ],
      })
      const r = await s.run('build_classify_bundles.py', ['2024r06h', '--data', 'data/ap', '--size', '3'])
      const files = s.list('data/ap/classify_bundles/2024r06h')
      return { r, list: files.map((f) => json(s, `data/ap/classify_bundles/2024r06h/${f}`)) }
    })
    // @covers REQ-638#split-by-size
    it('回の問題を指定した数ずつの束に分ける', async () => {
      const { r, list } = await bundles()
      ok(r)
      expect(list.map((b) => b.questions.map((q: { number: number }) => q.number))).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    })
    // @covers REQ-638#official-field-items-only
    it('各束には、その束の問題の公式の分野に属するシラバスの項目だけを添える', async () => {
      const { list } = await bundles()
      expect(list.map((b) => b.syllabus_candidates.map((c: { number: number }) => c.number).sort())).toEqual([[1], [2], [3]])
    })
  })

  describe('担当の分類の結果から論点を作り、過去問と紐づけ、紐づく件数を出題頻度として書き出す（REQ-639）', () => {
    // @covers REQ-639#topics-and-frequency
    it('2 回の分類の結果から、論点ごとに紐づく過去問と出題頻度を書き出す', async () => {
      const s = shadow41()
      s.json('data/ip/syllabus.json', {
        version: 'x',
        items: [
          { number: 1, name: '経営・組織論', field: 'ストラテジ系', major_no: 1, major: '企業と法務', middle_no: 1, middle: '企業活動', terms: ['株主総会'] },
          { number: 2, name: '離散数学', field: 'テクノロジ系', major_no: 7, major: '基礎理論', middle_no: 10, middle: '基礎理論', terms: ['集合'] },
        ],
      })
      s.json('data/ip/exam_labels.json', { '2024r06': '令和6年度', '2023r05': '令和5年度' })
      s.json('data/ip/answer_keys.json', { '2024r06': { 1: 'ア', 2: 'イ', 3: 'ウ' }, '2023r05': { 1: 'ア', 2: 'イ', 3: 'ウ' } })
      const c = (n: number, item: number, term: string) => ({ number: n, syllabus_item: item, topic_term: term, topic_is_new: false, related_terms: [], confidence: 'high', notes: null })
      for (const e of ['2024r06', '2023r05']) {
        s.json(`data/ip/questions/${e}.json`, { exam: e, question_count: 3, questions: [1, 2, 3].map((n) => extractedQ(n, 1)) })
        s.json(`data/ip/classified/${e}/batch_01.json`, { exam: e, range: '1-3', classifications: [c(1, 1, '株主総会'), c(2, 2, '集合'), c(3, 1, e === '2024r06' ? '株主総会' : 'SWOT 分析')] })
      }
      const r = await s.run('build_topics.py', ['--data', 'data/ip'])
      ok(r)
      const topics = json(s, 'data/ip/topics.json').topics as Array<{ term: string; question_count: number; questions: { exam: string; number: number }[] }>
      const view = Object.fromEntries(topics.map((t) => [t.term, { count: t.question_count, questions: t.questions.map((q) => `${q.exam}-${q.number}`).sort() }]))
      expect(view).toEqual({
        株主総会: { count: 3, questions: ['2023r05-1', '2024r06-1', '2024r06-3'] },
        集合: { count: 2, questions: ['2023r05-2', '2024r06-2'] },
        'SWOT 分析': { count: 1, questions: ['2023r05-3'] },
      })
    })

    // @covers REQ-639#same-question-counted-once
    it('同じ回・同じ問番号の過去問が 2 つの分類の結果で同じ論点に入っていても、紐づく過去問に 1 回だけ載せ、出題頻度に 1 回だけ数える', async () => {
      const s = shadow41()
      s.json('data/ip/syllabus.json', {
        version: 'x',
        items: [{ number: 1, name: '経営・組織論', field: 'ストラテジ系', major_no: 1, major: '企業と法務', middle_no: 1, middle: '企業活動', terms: ['株主総会'] }],
      })
      s.json('data/ip/exam_labels.json', { '2024r06': '令和6年度' })
      s.json('data/ip/answer_keys.json', { '2024r06': { 1: 'ア', 2: 'イ' } })
      s.json('data/ip/questions/2024r06.json', { exam: '2024r06', question_count: 2, questions: [1, 2].map((n) => extractedQ(n, 1)) })
      const c = (n: number) => ({ number: n, syllabus_item: 1, topic_term: '株主総会', topic_is_new: false, related_terms: [], confidence: 'high', notes: null })
      // 問1 が 2 つの分類の結果の両方に入る
      s.json('data/ip/classified/2024r06/batch_01.json', { exam: '2024r06', range: '1-2', classifications: [c(1), c(2)] })
      s.json('data/ip/classified/2024r06/batch_02.json', { exam: '2024r06', range: '1-1', classifications: [c(1)] })
      const r = await s.run('build_topics.py', ['--data', 'data/ip'])
      ok(r)
      const topics = json(s, 'data/ip/topics.json').topics as Array<{ term: string; question_count: number; questions: { exam: string; number: number }[] }>
      const t = topics.find((x) => x.term === '株主総会')
      expect(t, '論点が無い').toBeDefined()
      expect(t!.questions.map((q) => `${q.exam}-${q.number}`).sort()).toEqual(['2024r06-1', '2024r06-2'])
      expect(t!.question_count).toBe(2)
    })
  })

  describe('図の位置の一覧にある問題ごとに、ページの範囲を画像として配信の置き場に書き出す（REQ-640）', () => {
    // @covers REQ-640#figure-per-question
    it('図の位置の一覧の問題ごとに、問題冊子のそのページの範囲を画像にする', async () => {
      const s = shadow41()
      makePdf(s.path('data/ip/pdfs/2024r06_ip_qs.pdf'), [['問1'], ['問2 図'], ['問3 図']])
      s.json('data/ip/figures/boxes.json', {
        '2024r06-q2': { page: 2, x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.3 },
        '2024r06-q3': { page: 3, x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
      })
      const r = await s.run('crop_figures.py', ['--boxes', 'data/ip/figures/boxes.json', '--pdf-dir', 'data/ip/pdfs', '--out', 'public/figures/ip', '--dpi', '72'])
      ok(r)
      expect(s.list('public/figures/ip').filter((f) => f.endsWith('.png')).sort()).toEqual(['2024r06-q2.png', '2024r06-q3.png'])
      const q3 = pngSize(s.path('public/figures/ip/2024r06-q3.png'))
      // 範囲の幅と高さ（ページの半分ずつ）に、5% までの余白を許す
      const near = (got: number, want: number) => got >= want * 0.95 && got <= want * 1.05
      expect(near(q3.width, 595 / 2) && near(q3.height, 842 / 2), `範囲の大きさでない: ${q3.width}x${q3.height}`).toBe(true)
    })
  })

  describe('読む物が無いか、PDF を読む部品が入っていなければ、理由を示して失敗で終える（REQ-641）', () => {
    // @covers REQ-641#booklet-missing
    it('問題冊子の PDF が無ければ（ページを画像にする）', async () => {
      failedWith(await shadow41().run('render_pages.py', ['2024r06', '--data', 'data/ip']), '2024r06')
    })
    // @covers REQ-641#answer-pdf-missing
    it('解答例の PDF が無ければ（正解表を作る）', async () => {
      const s = shadow41()
      // 理由の文の中身（解答例が無いこと）を見る。引数のパスに出る語では照らさない
      failedWith(await s.run('extract_answer_keys_ap.py', ['--data', 'data/ap', '--pdf-dir', 'data/ap/pdfs']), '解答例')
    })
    // @covers REQ-641#extracted-missing
    it('読み取りの結果が無ければ（まとめる）', async () => {
      failedWith(await shadow41().run('merge_questions.py', ['2024r06', '--extracted-dir', 'data/ip/extracted', '--out-dir', 'out/questions']), '2024r06')
    })
    // @covers REQ-641#fields-missing
    it('回の公式の分野が無ければ（分類の束を作る）', async () => {
      const s = shadow41()
      s.json('data/fe/questions/2024r06x.json', { exam: '2024r06x', question_count: 1, questions: [extractedQ(1, 1)] })
      s.json('data/fe/syllabus_index.json', { items: [] })
      failedWith(await s.run('build_classify_bundles.py', ['2024r06x', '--data', 'data/fe', '--size', '3']), 'question_fields')
    })
    // @covers REQ-641#classified-missing
    it('分類の結果が無ければ（論点を組む）', async () => {
      const s = shadow41()
      s.json('data/ip/syllabus.json', { version: 'x', items: [] })
      s.json('data/ip/exam_labels.json', {})
      s.json('data/ip/answer_keys.json', {})
      failedWith(await s.run('build_topics.py', ['--data', 'data/ip']), 'classified')
    })
    // @covers REQ-641#topic-inputs-missing
    it('回の名前の表が無ければ（論点を組む）、名前の無い例外で止まらず、無い物を 1 行で名指して失敗で終える', async () => {
      const s = shadow41()
      s.json('data/ip/syllabus.json', { version: 'x', items: [{ number: 1, name: '経営・組織論', field: 'ストラテジ系', major_no: 1, major: '企業と法務', middle_no: 1, middle: '企業活動', terms: [] }] })
      s.json('data/ip/answer_keys.json', { '2024r06': { 1: 'ア' } })
      s.json('data/ip/questions/2024r06.json', { exam: '2024r06', question_count: 1, questions: [extractedQ(1, 1)] })
      s.json('data/ip/classified/2024r06/batch_01.json', {
        exam: '2024r06',
        range: '1-1',
        classifications: [{ number: 1, syllabus_item: 1, topic_term: '株主総会', topic_is_new: false, related_terms: [], confidence: 'high', notes: null }],
      })
      const r = await s.run('build_topics.py', ['--data', 'data/ip'])
      failedWith(r, 'exam_labels')
      expect(r.out.split('\n').some((l) => l.includes('exam_labels')), `無い物を 1 行で名指していない: ${r.out.slice(-600)}`).toBe(true)
    })
    // @covers REQ-641#boxes-missing
    it('図の位置の一覧が無ければ（図を切り出す）', async () => {
      failedWith(await shadow41().run('crop_figures.py', ['--boxes', 'data/ip/figures/none.json', '--pdf-dir', 'data/ip/pdfs', '--out', 'public/figures/ip']), 'none.json')
    })
    // @covers REQ-641#pdf-reader-missing
    it('PDF を読む部品が入っていなければ（ページを画像にする）', async () => {
      const s = shadow41()
      makePdf(s.path('data/ip/pdfs/2024r06_ip_qs.pdf'), [['問1']])
      // 部品を読み込めない環境（読み込むと ImportError になる fitz を先に見つけさせる）
      s.write('no-pdf-reader/fitz.py', 'raise ImportError("uc041: PDF を読む部品が入っていない")\n')
      s.write('no-pdf-reader/pymupdf.py', 'raise ImportError("uc041: PDF を読む部品が入っていない")\n')
      const r = await s.run('render_pages.py', ['2024r06', '--data', 'data/ip'], { PYTHONPATH: s.path('no-pdf-reader') })
      expect(crashed(r), `名前の無い例外で止まった: ${r.out.slice(-600)}`).toBe(false)
      expect(r.code, r.out.slice(-600)).not.toBe(0)
      expect(/PyMuPDF|pymupdf|fitz|pip/i.test(r.out), `部品が無いことを示していない: ${r.out.slice(-600)}`).toBe(true)
    })
  })
})

/** 同じ仕込みで 1 回だけ回す。 */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => (p ??= make())
}


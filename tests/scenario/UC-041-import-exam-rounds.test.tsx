/** UC-041「過去問の回を取り込む」の主シナリオを 1 本で実行する写し（正常系のみ。止まり方は各要件のテストが見る）。
 *  作り手の手元を影の根（tests/server/UC-041_fixture.ts）に置き、応用情報の 1 回（2024r06h）を取り込む。
 *  PDF を取る段は、取りに行く先に手元の偽の配布先（公開の場所と同じパスの一覧のページと PDF を返す）を指定して回す。 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  A, LOCAL_NO_PROXY, apAnswerPdf, apSite, crashed, extractedQ, localDistributor, makePdf, removeTemps, shadow41, syllabusPdf, type Run, type SylPage,
} from '../server/UC-041_fixture'

afterAll(removeTemps)

const EXAM = '2024r06h'
const done = (r: Run, step: string) => {
  expect(crashed(r), `${step}: ${r.out.slice(-500)}`).toBe(false)
  expect(r.code, `${step}: ${r.out.slice(-500)}`).toBe(0)
}

describe('UC-041 過去問の回を取り込む', () => {
  // @scenario UC-041
  it('作り手が応用情報の 1 回を取り込み、問題・正解表・分類の受け皿・論点と出題頻度・図が置き場に書き出されたことを見る', async () => {
    const s = shadow41()

    // 1. 作り手が、過去問の問題冊子と解答例の PDF を取る（取りに行く先は手元の偽の配布先）
    const d = await localDistributor(apSite({ '2024r06': [EXAM] }))
    try {
      done(await s.run('fetch_pdfs_ap.py', ['--exam', 'ap', '--exams', EXAM, '--origin', d.origin, '--out', 'data/ap/pdfs'], LOCAL_NO_PROXY), 'PDF を取る')
    } finally {
      await d.close()
    }
    expect(s.list('data/ap/pdfs'), '取った PDF が置き場に無い').toEqual([`${EXAM}_ap_am_ans.pdf`, `${EXAM}_ap_am_qs.pdf`])
    // 読み取りと正解表の段が読める中身に差し替える（偽の配布先の PDF は 1 行だけの作り物）
    makePdf(s.path(`data/ap/pdfs/${EXAM}_ap_am_qs.pdf`), [['問1 図'], ['問2'], ['問3']])
    apAnswerPdf(s, `data/ap/pdfs/${EXAM}_ap_am_ans.pdf`, (n) => A[n % 4], (n) => (n <= 50 ? 'Ｔ' : n <= 60 ? 'Ｍ' : 'Ｓ'))

    // 2. 作り手が、問題冊子のページを画像に書き出し、読み取った結果を 1 回分の問題にまとめる
    done(await s.run('render_pages.py', [EXAM, '--data', 'data/ap', '--dpi', '72']), 'ページを画像にする')
    expect(s.list(`data/ap/pages/${EXAM}`).length, 'ページの画像が無い').toBe(3)
    const qs = Array.from({ length: 80 }, (_, i) => extractedQ(i + 1, Math.min(3, 1 + Math.floor(i / 30))))
    s.json(`data/ap/extracted/${EXAM}/chunk_01.json`, { exam: EXAM, pages: [1, 2], questions: qs.slice(0, 40) })
    s.json(`data/ap/extracted/${EXAM}/chunk_02.json`, { exam: EXAM, pages: [2, 3], questions: qs.slice(40) })
    done(await s.run('merge_questions.py', [EXAM, '--extracted-dir', 'data/ap/extracted', '--out-dir', 'data/ap/questions', '--count', '80']), '読み取りをまとめる')

    // 3. 作り手が、解答例から正解表と公式の分野を、シラバスから分類の受け皿を作る
    done(await s.run('extract_answer_keys_ap.py', ['--data', 'data/ap']), '正解表を作る')
    const pages: SylPage[] = [
      { field: 'テクノロジ系', major: [1, '基礎理論'], middle: [1, '基礎理論'], items: [{ no: 1, name: '離散数学', terms: ['集合'] }] },
      { field: 'マネジメント系', major: [5, 'プロジェクトマネジメント'], middle: [14, 'プロジェクトマネジメント'], items: [{ no: 1, name: '計画', terms: ['WBS'] }] },
      { field: 'ストラテジ系', major: [7, 'システム戦略'], middle: [16, 'システム戦略'], items: [{ no: 1, name: '情報システム戦略', terms: ['EA'] }] },
    ]
    syllabusPdf(s, 'data/ap/syllabus_ap_ver9_9.pdf', pages, (i) => `-${i}- `)
    done(await s.run('parse_syllabus_ap.py', ['--data', 'data/ap']), 'シラバスを読む')

    // 4. 作り手が、回の分類の束を作り、担当の分類の結果から論点と出題頻度を組む
    done(await s.run('build_classify_bundles.py', [EXAM, '--data', 'data/ap', '--size', '40']), '分類の束を作る')
    expect(s.list(`data/ap/classify_bundles/${EXAM}`).length, '分類の束が無い').toBe(2)
    const items = (JSON.parse(s.read('data/ap/syllabus.json')!).items as { number: number; field: string }[])
    const fields = JSON.parse(s.read('data/ap/question_fields.json')!)[EXAM] as Record<string, string>
    const itemOf = (n: number) => items.find((it) => it.field === fields[String(n)])!.number
    for (const [batch, range] of [['batch_01', [1, 40]], ['batch_02', [41, 80]]] as const) {
      s.json(`data/ap/classified/${EXAM}/${batch}.json`, {
        exam: EXAM,
        range: `${range[0]}-${range[1]}`,
        classifications: Array.from({ length: range[1] - range[0] + 1 }, (_, i) => {
          const n = range[0] + i
          return { number: n, syllabus_item: itemOf(n), topic_term: `論点${n % 10}`, topic_is_new: false, related_terms: [], confidence: 'high', notes: null }
        }),
      })
    }
    s.json('data/ap/exam_labels.json', { [EXAM]: '令和6年度 春期' })
    done(await s.run('build_topics.py', ['--data', 'data/ap']), '論点を組む')

    // 5. 作り手が、図を含む問題の図をページ画像から切り出す
    s.json('data/ap/figures/boxes.json', { [`${EXAM}-q1`]: { page: 1, x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 } })
    done(await s.run('crop_figures.py', ['--boxes', 'data/ap/figures/boxes.json', '--pdf-dir', 'data/ap/pdfs', '--out', 'public/figures/ap', '--dpi', '72']), '図を切り出す')

    // 6 と成功時: 回の問題・正解表・分類の受け皿・論点と出題頻度・図が置き場に書き出されている
    expect(JSON.parse(s.read(`data/ap/questions/${EXAM}.json`)!).questions.length).toBe(80)
    expect(Object.keys(JSON.parse(s.read('data/ap/answer_keys.json')!)[EXAM]).length).toBe(80)
    expect(items.length).toBe(3)
    const topics = JSON.parse(s.read('data/ap/topics.json')!).topics as { question_count: number }[]
    expect(topics.length).toBe(10)
    expect(topics.reduce((sum, t) => sum + t.question_count, 0)).toBe(80)
    expect(s.list('public/figures/ap')).toEqual([`${EXAM}-q1.png`])
  }, 300_000)
})

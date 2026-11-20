/**
 * UC-041 の受け持ち（過去問の回を取り込む道具 11 本。入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行:
 * 操作名を snake_case にした `scripts/<名前>.py`）。request の各欄は同じ名前の引数（契約の先頭の決まり: 回の ID は第 1 引数、
 * ほかは --名前。pdfDir は --pdf-dir のように大文字の前に - を入れた小文字。exams は名前の後ろに値を並べる）。
 * 応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 *
 * 囲いは UC-041 のテストの土台（tests/server/UC-041_fixture.ts の shadow41）をそのまま使う: 影の根に scripts と src/shared を写し、
 * 道具は OS の囲い（外への接続と、作業ツリー・本体への書き込みを断つ）の中で回す。前提の PDF と JSON は影の根の中に作る
 * （契約が名指す tests/fixtures/import の下のパスも影の根の中に作り、リポジトリには置かない）。
 * 前提（例の名前ごと。どれも ok）:
 * - fetchPdfs・fetchPdfsAp: 例の origin（http://127.0.0.1:<口>）に、受け渡し役が手元の偽の配布先を起こし、公開の場所と同じパスの一覧のページと
 *   PDF を返す（IT パスポートは回 2024r06、応用情報は年度 2024r06 の回 2024r06h）。例が終われば片付ける
 * - renderPages: 問題冊子 2024r06_ip_qs.pdf（3 ページ）
 * - mergeQuestions: data/ip/extracted/2024r06 に 2 つの範囲で 100 問
 * - extractAnswerKeys: 解答例 2024r06_ip_ans.pdf（100 問）
 * - extractAnswerKeysAp: 解答例 2024r06h_ap_am_ans.pdf（80 問と分野）
 * - parseSyllabus: リポジトリのシラバスの PDF（data/ip/syllabus_ip_ver6_5.pdf）の写し
 * - parseSyllabusAp: リポジトリのシラバスの PDF（data/ap/syllabus_ap_ver7_2.pdf）の写し
 * - buildClassifyBundles: 回 2024r06h の 4 問と公式の分野と索引
 * - buildTopics: 2 回の各 3 問の分類の結果・問題・シラバス・回の名前・正解表
 * - cropFigures: 問題冊子と、2 問の図の位置の一覧
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  A, LOCAL_NO_PROXY, ROOT, apAnswerPdf, apSite, extractedQ, ipAnswerPdf, ipSite, localDistributor, makePdf, removeTemps, shadow41, type Run, type Shadow41, type Site,
} from '../../../tests/server/UC-041_fixture'
import { defineHandler, Unanswerable, type Answer, type ExampleLine, type Operation } from '../kit/protocol'
import { toolAnswer } from '../kit/tool'

type Request = Record<string, unknown>
const flag = (name: string) => `--${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
/** 契約の request を道具の引数にする（positional の欄を先に。ほかは --名前、配列は名前の後ろに値を並べる）。 */
function argumentsOf(request: Request | null, positional: string[]): string[] {
  const body = request ?? {}
  const out: string[] = positional.filter((k) => body[k] !== undefined).map((k) => String(body[k]))
  for (const [key, v] of Object.entries(body)) {
    if (positional.includes(key) || v === undefined || v === null || v === false) continue
    if (v === true) out.push(flag(key))
    else if (Array.isArray(v)) out.push(flag(key), ...v.map(String))
    else out.push(flag(key), String(v))
  }
  return out
}
const answer = (r: Run): Answer => toolAnswer({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr }, (run) => ({ exitCode: run.code }))
const copyFromRepo = (s: Shadow41, rel: string) => {
  mkdirSync(dirname(s.path(rel)), { recursive: true })
  copyFileSync(join(ROOT, rel), s.path(rel))
}
const str = (req: Request | null, key: string, fallback: string) => (typeof req?.[key] === 'string' ? (req[key] as string) : fallback)

type Plan = { script: string; positional: string[]; prepare: (s: Shadow41, req: Request | null) => void }
const PLANS: Record<string, Plan> = {
  renderPages: {
    script: 'render_pages.py',
    positional: ['exam'],
    prepare: (s, req) => makePdf(s.path(`${str(req, 'data', 'data/ip')}/pdfs/${str(req, 'exam', '2024r06')}_ip_qs.pdf`), [['問1'], ['問2'], ['問3']]),
  },
  mergeQuestions: {
    script: 'merge_questions.py',
    positional: ['exam'],
    prepare: (s, req) => {
      const exam = str(req, 'exam', '2024r06')
      const qs = Array.from({ length: 100 }, (_, i) => extractedQ(i + 1, 1 + Math.floor(i / 10)))
      s.json(`data/ip/extracted/${exam}/chunk_01.json`, { exam, pages: [1, 5], questions: qs.slice(0, 50) })
      s.json(`data/ip/extracted/${exam}/chunk_02.json`, { exam, pages: [6, 10], questions: qs.slice(50) })
    },
  },
  extractAnswerKeys: {
    script: 'extract_answer_keys.py',
    positional: [],
    prepare: (s, req) => ipAnswerPdf(s, `${str(req, 'pdfDir', 'data/ip/pdfs')}/2024r06_ip_ans.pdf`, (n) => A[n % 4]),
  },
  extractAnswerKeysAp: {
    script: 'extract_answer_keys_ap.py',
    positional: [],
    prepare: (s, req) => apAnswerPdf(s, `${str(req, 'data', 'data/ap')}/pdfs/2024r06h_ap_am_ans.pdf`, (n) => A[n % 4], (n) => (n <= 50 ? 'Ｔ' : n <= 60 ? 'Ｍ' : 'Ｓ')),
  },
  parseSyllabus: { script: 'parse_syllabus.py', positional: [], prepare: (s) => copyFromRepo(s, 'data/ip/syllabus_ip_ver6_5.pdf') },
  parseSyllabusAp: { script: 'parse_syllabus_ap.py', positional: [], prepare: (s) => copyFromRepo(s, 'data/ap/syllabus_ap_ver7_2.pdf') },
  buildClassifyBundles: {
    script: 'build_classify_bundles.py',
    positional: ['exam'],
    prepare: (s, req) => {
      const exam = str(req, 'exam', '2024r06h')
      const data = str(req, 'data', 'data/ap')
      const qs = [1, 2, 3, 4].map((n) => extractedQ(n, 1))
      s.json(`${data}/questions/${exam}.json`, { exam, question_count: 4, questions: qs })
      s.json(`${data}/question_fields.json`, { [exam]: { 1: 'テクノロジ系', 2: 'テクノロジ系', 3: 'マネジメント系', 4: 'ストラテジ系' } })
      s.json(`${data}/syllabus_index.json`, {
        items: [
          { number: 1, name: '離散数学', field: 'テクノロジ系', major: '基礎理論', middle: '基礎理論', middle_no: 1, terms: ['集合'] },
          { number: 2, name: '計画', field: 'マネジメント系', major: 'PM', middle: 'PM', middle_no: 14, terms: ['WBS'] },
          { number: 3, name: '情報システム戦略', field: 'ストラテジ系', major: 'システム戦略', middle: 'システム戦略', middle_no: 16, terms: ['EA'] },
        ],
      })
    },
  },
  buildTopics: {
    script: 'build_topics.py',
    positional: [],
    prepare: (s, req) => {
      const data = str(req, 'data', 'data/ip')
      s.json(`${data}/syllabus.json`, {
        version: 'x',
        items: [{ number: 1, name: '経営・組織論', field: 'ストラテジ系', major_no: 1, major: '企業と法務', middle_no: 1, middle: '企業活動', terms: ['株主総会'] }],
      })
      s.json(`${data}/exam_labels.json`, { '2024r06': '令和6年度', '2023r05': '令和5年度' })
      s.json(`${data}/answer_keys.json`, { '2024r06': { 1: 'ア', 2: 'イ', 3: 'ウ' }, '2023r05': { 1: 'ア', 2: 'イ', 3: 'ウ' } })
      for (const exam of ['2024r06', '2023r05']) {
        s.json(`${data}/questions/${exam}.json`, { exam, question_count: 3, questions: [1, 2, 3].map((n) => extractedQ(n, 1)) })
        s.json(`${data}/classified/${exam}/batch_01.json`, {
          exam,
          range: '1-3',
          classifications: [1, 2, 3].map((n) => ({ number: n, syllabus_item: 1, topic_term: n === 3 ? '決算' : '株主総会', topic_is_new: false, related_terms: [], confidence: 'high', notes: null })),
        })
      }
    },
  },
  cropFigures: {
    script: 'crop_figures.py',
    positional: [],
    prepare: (s, req) => {
      makePdf(s.path(`${str(req, 'pdfDir', 'data/ip/pdfs')}/2024r06_ip_qs.pdf`), [['問1'], ['問2 図']])
      s.json(str(req, 'boxes', 'data/ip/figures/boxes.json'), {
        '2024r06-q1': { page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.3 },
        '2024r06-q2': { page: 2, x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.6 },
      })
    },
  },
}

function operation(name: string): Operation {
  return async (line: ExampleLine) => {
    if (line.case !== 'ok') throw new Unanswerable(`UC-041 ${line.operation} の例 ${line.case} の前提を知らない`)
    const plan = PLANS[name]
    const s = shadow41()
    try {
      plan.prepare(s, line.request)
      return answer(await s.run(plan.script, argumentsOf(line.request, plan.positional)))
    } finally {
      removeTemps()
    }
  }
}
/** 例の origin に手元の偽の配布先を起こして道具を回し、終われば片付ける。 */
const fetching = (script: string, site: () => Site): Operation => async (line: ExampleLine) => {
  if (line.case !== 'ok') throw new Unanswerable(`UC-041 ${line.operation} の例 ${line.case} の前提を知らない`)
  const origin = new URL(str(line.request, 'origin', ''))
  if (origin.hostname !== '127.0.0.1') throw new Unanswerable(`UC-041 ${line.operation}.ok: 手元でない取りに行く先には回さない（${origin.hostname}）`)
  const distributor = await localDistributor(site(), Number(origin.port))
  const s = shadow41()
  try {
    return answer(await s.run(script, argumentsOf(line.request, []), LOCAL_NO_PROXY))
  } finally {
    await distributor.close()
    removeTemps()
  }
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-041',
  // 土台が同期の子プロセス（spawnSync）で道具を回すので、受け渡し役の本体を止めないよう、自分のプロセスで 1 件ずつ回す
  ownProcess: true,
  operations: {
    ...Object.fromEntries(Object.keys(PLANS).map((name) => [name, operation(name)])),
    fetchPdfs: fetching('fetch_pdfs.py', () => ipSite(['2024r06'])),
    fetchPdfsAp: fetching('fetch_pdfs_ap.py', () => apSite({ '2024r06': ['2024r06h'] })),
  },
})

/** UC-041（過去問の回を取り込む道具 11 本）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作名を snake_case にした `scripts/<名前>.py` を子プロセスで回す
 *  （fetchPdfs ＝ fetch_pdfs.py、fetchPdfsAp ＝ fetch_pdfs_ap.py、renderPages ＝ render_pages.py、mergeQuestions ＝ merge_questions.py、
 *  extractAnswerKeys ＝ extract_answer_keys.py、extractAnswerKeysAp ＝ extract_answer_keys_ap.py、parseSyllabus ＝ parse_syllabus.py、
 *  parseSyllabusAp ＝ parse_syllabus_ap.py、buildClassifyBundles ＝ build_classify_bundles.py、buildTopics ＝ build_topics.py、
 *  cropFigures ＝ crop_figures.py）。request の各欄は同じ名前の引数（回の ID は第 1 引数。pdfDir は --pdf-dir のように、大文字の前に
 *  - を入れた小文字）。観測するのは終了の状態・出力の文・書き出したファイルだけ。
 *
 *  影の根（一時の置き場）に scripts と src/shared を写し、data は空の学びの置き場だけを作る（リポジトリの data にはリンクしない）。
 *  入力の PDF と画像は、テストの中で PyMuPDF（PDF を読む部品と同じ物）で小さく作る。
 *  道具は OS の囲い（macOS の sandbox-exec）の中で回す: 作業ツリーとその隣（本体のチェックアウト）への書き込みを断ち、
 *  外への接続は手元（127.0.0.1）のほかは断つ。環境の代理も届かない口に向ける。
 *  PDF を取る 2 本は、取りに行く先（--origin）に手元の偽の配布先（localDistributor。http、空いている口）を指定して回す。
 *  取りに行く先を指定しないときは、環境の代理を宛先を記録して断る代理（refusingProxy）に向け、断った宛先を見る（外の相手には届かない）。 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 道具を囲う OS の決まり。外への接続は手元のほかを断ち、作業ツリーとその隣への書き込みを断つ。macOS 以外では囲わない。 */
const SANDBOX: string | null =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? `(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))(deny file-write* (subpath ${JSON.stringify(dirname(ROOT))}))`
    : null

const temps: string[] = []
/** 作った影の根を消す。 */
export function removeTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export type Run = { code: number | null; stdout: string; stderr: string; out: string }
export type Shadow41 = {
  root: string
  path: (rel: string) => string
  write: (rel: string, content: string | Buffer) => void
  json: (rel: string, value: unknown) => void
  read: (rel: string) => string | null
  list: (rel: string) => string[]
  /** 道具を回す（作業の場所は影の根。囲いの中）。env は足す環境変数。 */
  run: (script: string, args?: string[], env?: Record<string, string>) => Promise<Run>
}

/** 影の根を作る。learnings は空の置き場を作る学び。 */
export function shadow41(learnings: string[] = ['ip', 'ap', 'fe']): Shadow41 {
  const base = mkdtempSync(join(tmpdir(), 'uc041-'))
  temps.push(base)
  const root = join(base, 'root')
  mkdirSync(join(root, 'src'), { recursive: true })
  const cp = spawnSync('cp', [process.platform === 'darwin' ? '-cR' : '-R', join(ROOT, 'scripts'), `${root}/`])
  if (cp.status !== 0) cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'src', 'shared'), join(root, 'src', 'shared'), { recursive: true })
  for (const k of learnings) mkdirSync(join(root, 'data', k), { recursive: true })
  const path = (rel: string) => join(root, rel)
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(dirname(path(rel)), { recursive: true })
    writeFileSync(path(rel), content)
  }
  return {
    root,
    path,
    write,
    json: (rel, value) => write(rel, JSON.stringify(value, null, 1)),
    read: (rel) => (existsSync(path(rel)) ? readFileSync(path(rel), 'utf8') : null),
    list: (rel) => (existsSync(path(rel)) ? readdirSync(path(rel)).sort() : []),
    run: (script, args = [], env = {}) =>
      new Promise((resolve) => {
        const command = SANDBOX ? 'sandbox-exec' : 'python3'
        const argv = [...(SANDBOX ? ['-p', SANDBOX, 'python3'] : []), join(root, 'scripts', script), ...args]
        const child = spawn(command, argv, {
          cwd: root,
          env: {
            ...process.env,
            HTTPS_PROXY: 'http://127.0.0.1:9',
            HTTP_PROXY: 'http://127.0.0.1:9',
            https_proxy: 'http://127.0.0.1:9',
            http_proxy: 'http://127.0.0.1:9',
            NO_PROXY: '',
            no_proxy: '',
            ...env,
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => (stdout += c))
        child.stderr.on('data', (c) => (stderr += c))
        const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr, out: `${stdout}\n${stderr}` })
        })
      }),
  }
}

/** 道具が名前の無い例外で止まったか。 */
export const crashed = (r: Run) => /Traceback \(most recent call last\)/.test(r.stderr)

/** PyMuPDF で小さな PDF を作る。pages はページごとの文の行（日本語の文字は CJK のフォントで書く）。 */
export function makePdf(file: string, pages: string[][]): void {
  mkdirSync(dirname(file), { recursive: true })
  const code = `
import json, sys, fitz
pages = json.loads(sys.argv[2])
doc = fitz.open()
for lines in pages:
    page = doc.new_page(width=595, height=842)
    y = 60
    for line in lines:
        page.insert_text((50, y), line, fontname="japan", fontsize=10)
        y += 16
doc.save(sys.argv[1])
`
  const r = spawnSync('python3', ['-c', code, file, JSON.stringify(pages)], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`PDF を作れない: ${r.stderr.slice(-300)}`)
}

/** PDF のページ数と、ページごとの文（PDF を読む部品で読む）。 */
export function pdfText(file: string): string[] {
  const r = spawnSync('python3', ['-c', 'import json,sys,fitz; print(json.dumps([p.get_text() for p in fitz.open(sys.argv[1])], ensure_ascii=False))', file], { encoding: 'utf8' })
  return JSON.parse(r.stdout)
}

/** PNG の幅と高さ。 */
export function pngSize(file: string): { width: number; height: number } {
  const b = new DataView(new Uint8Array(readFileSync(file)).buffer)
  return { width: b.getUint32(16), height: b.getUint32(20) }
}

// ---- 偽の配布先の答え ----

/** 偽の配布先の答え（パス → 本文）。 */
export type Site = Record<string, { type: string; body: string | Buffer }>

/** PDF の中身（PyMuPDF で作った 1 ページの PDF のバイト列）。 */
export function pdfBytes(lines: string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'uc041-pdf-'))
  temps.push(dir)
  makePdf(join(dir, 'x.pdf'), [lines])
  return readFileSync(join(dir, 'x.pdf'))
}

// ---- 入力の作り物（テストと受け渡し役が共有する） ----

export const A = ['ア', 'イ', 'ウ', 'エ'] as const
/** 読み取りの結果の 1 問。 */
export const extractedQ = (n: number, page: number, text = `問題文${n}として正しいものはどれか。`) => ({
  number: n, page, text, choices: { ア: `選択${n}ア`, イ: `選択${n}イ`, ウ: `選択${n}ウ`, エ: `選択${n}エ` },
  has_figure: false, figure_description: null, confidence: 'high', notes: null,
})

/** 語を決めた位置に置いた PDF（ページごとに [x, y, 文]）。 */
export function wordsPdf(s: Shadow41, rel: string, pages: [number, number, string][][]) {
  const code = `
import json, sys, fitz
doc = fitz.open()
for words in json.loads(sys.argv[2]):
    p = doc.new_page(width=595, height=842)
    for x, y, t in words:
        p.insert_text((x, y), t, fontname="japan", fontsize=9)
import os
os.makedirs(os.path.dirname(sys.argv[1]), exist_ok=True)
doc.save(sys.argv[1])`
  const r = spawnSync('python3', ['-c', code, s.path(rel), JSON.stringify(pages)], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}
/** IT パスポートの解答例（問番号と正解の表。100 問を 4 列に）。answer(n) が正解。 */
export function ipAnswerPdf(s: Shadow41, rel: string, answer: (n: number) => string) {
  const w: [number, number, string][] = [[309, 119, '公開問題'], [369, 119, '解答例'], [96, 119, '令和6年度'], [204, 119, 'ITパスポート試験'], [101, 155, '問番号'], [152, 155, '正解']]
  for (let n = 1; n <= 100; n++) {
    const col = Math.floor((n - 1) / 25)
    const row = (n - 1) % 25
    w.push([101 + col * 102, 175 + row * 20, `問${n}`], [152 + col * 102, 175 + row * 20, answer(n)])
  }
  wordsPdf(s, rel, [w])
}
/** 応用情報の解答例（問番号・正解・分野の表。80 問を 4 列に）。field(n) は Ｔ・Ｍ・Ｓ。 */
export function apAnswerPdf(s: Shadow41, rel: string, answer: (n: number) => string, field: (n: number) => string) {
  const w: [number, number, string][] = [[85, 102, '令和6年度 春期 応用情報技術者試験 解答例'], [85, 138, '午前試験'], [91, 155, '問番号'], [131, 155, '正解'], [159, 155, '分野']]
  for (let n = 1; n <= 80; n++) {
    const col = Math.floor((n - 1) / 20)
    const row = (n - 1) % 20
    w.push([97 + col * 120, 170 + row * 18, `問${n}`], [135 + col * 120, 170 + row * 18, answer(n)], [163 + col * 120, 170 + row * 18, field(n)])
  }
  wordsPdf(s, rel, [w])
}
export type SylItem = { no: number; name: string; terms: string[] }
export type SylPage = { field: string; major: [number, string]; middle: [number, string]; items: SylItem[] }
/** シラバスの PDF（1 中分類 1 ページ）。footer はページ番号の行の形。 */
export function syllabusPdf(s: Shadow41, rel: string, pages: SylPage[], footer: (i: number) => string) {
  makePdf(
    s.path(rel),
    pages.map((p, i) => [
      footer(i + 1),
      'Copyright(c) Information-technology Promotion Agency, Japan. All rights reserved 2026',
      `${p.field} `,
      ' ',
      `大分類${p.major[0]}：${p.major[1]} 中分類${p.middle[0]}：${p.middle[1]}`,
      ' ',
      ...p.items.flatMap((it) => [`${it.no}. ${it.name} `, '【目標】 ', '➢ 基本的な考え方を理解する。', ' ', '(1) 小見出し ', '・内容の説明', `用語例 ${it.terms.join('，')} `, ' ']),
    ]),
  )
}
/** IT パスポートのシラバスの形（3 分野・9 大分類・23 中分類・63 項目）。 */
export function ipSyllabusPages(): SylPage[] {
  const fields = ['ストラテジ系', 'マネジメント系', 'テクノロジ系']
  const pages: SylPage[] = []
  let item = 1
  for (let m = 1; m <= 23; m++) {
    const major = Math.min(9, Math.ceil((m * 9) / 23))
    const count = m <= 17 ? 3 : 2
    const items: SylItem[] = Array.from({ length: count }, () => {
      const no = item++
      return { no, name: `項目名${no}`, terms: [`用語${no}の一`, `用語${no}の二`] }
    })
    pages.push({ field: fields[Math.floor((major - 1) / 3)], major: [major, `大分類名${major}`], middle: [m, `中分類名${m}`], items })
  }
  return pages
}


// ---- 手元の偽の配布先（http。取りに行く先に指定する） ----

export type LocalDistributor = {
  /** 取りに行く先（スキーム://ホスト:口）。 */
  origin: string
  /** 受けた要求のパス（来た順）。 */
  requests: string[]
  /** パス → 答え。テストの途中で足してよい。 */
  site: Site
  close: () => Promise<void>
}

/** 手元の偽の配布先を立てる。port を省くと空いている口を取る。site に無いパスには 404 を返す。 */
export async function localDistributor(site: Site, port = 0): Promise<LocalDistributor> {
  const requests: string[] = []
  const server = createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    requests.push(path)
    const page = site[path]
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': page.type }).end(page.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const actual = (server.address() as AddressInfo).port
  return { origin: `http://127.0.0.1:${actual}`, requests, site, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** 外へ出る宛先を記録して断る代理（環境の代理に向ける）。CONNECT の宛先と、平文の要求の URL を残し、どれにも 403 を返す。 */
export async function refusingProxy(): Promise<{ env: Record<string, string>; refused: string[]; close: () => Promise<void> }> {
  const refused: string[] = []
  const proxy = createHttpServer((req, res) => {
    refused.push(String(req.url ?? ''))
    res.writeHead(403).end()
  })
  proxy.on('connect', (req: IncomingMessage, socket: Socket) => {
    refused.push(`https://${String(req.url ?? '').replace(/:443$/, '')}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  return { env: { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url }, refused, close: () => new Promise((resolve) => proxy.close(() => resolve())) }
}

/** 一覧のページ（links を a の href に並べる）。 */
export const htmlPage = (links: string[]) => ({
  type: 'text/html; charset=utf-8',
  body: `<!doctype html><html><body><ul>${links.map((l) => `<li><a href="${l}">${l.split('/').pop()}</a></li>`).join('')}</ul></body></html>`,
})

/** 手元の偽の配布先が使うとき、代理を通さない宛先。 */
export const LOCAL_NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
/** IT パスポートの公開の配布の場所と同じパスの一覧のページと PDF（rounds の回ごとに問題冊子と解答例）。PDF の中身は回と種類で違う。 */
export function ipSite(rounds: string[]): Site {
  const names = rounds.flatMap((r) => [`${r}_ip_qs.pdf`, `${r}_ip_ans.pdf`])
  return {
    '/JitesCbt/html/openinfo/questions.html': htmlPage(names.map((n) => `./pdf/questions/${n}`)),
    ...Object.fromEntries(names.map((n) => [`/JitesCbt/html/openinfo/pdf/questions/${n}`, { type: 'application/pdf', body: pdfBytes([n]) }])),
  }
}
/** 応用情報の公開の場所と同じパスの一覧のページ（年度のページ）と PDF（years の年度ごとに、その年度の回の問題冊子と解答例）。 */
export function apSite(years: Record<string, string[]>): Site {
  const Y = '/shiken/mondai-kaiotu/'
  const site: Site = { [`${Y}index.html`]: htmlPage(Object.keys(years).map((y) => `${Y}${y}.html`)) }
  for (const [year, rounds] of Object.entries(years)) {
    const names = rounds.flatMap((r) => [`${r}_ap_am_qs.pdf`, `${r}_ap_am_ans.pdf`])
    site[`${Y}${year}.html`] = htmlPage(names.map((n) => `${Y}att/${n}`))
    for (const n of names) site[`${Y}att/${n}`] = { type: 'application/pdf', body: pdfBytes([n]) }
  }
  return site
}

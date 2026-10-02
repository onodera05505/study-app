/** 表示側（React コンポーネント）を実データ全件で描画して検査する。
 *
 *     bash scripts/check_render.sh ip
 *     bash scripts/check_render.sh ap
 *
 * ## なぜ要るか
 *
 * 2026-09-01、用語ポップ `[[用語]]` を反映した直後に「ポップが見つからない」と
 * 報告があった。原因は `Markdown.tsx` の行内パーサが `**[[用語]]**`
 * （教材の「混同しやすい用語」の定型。教材内の用語指定の IP 93% / AP 88%）で
 * `[[…]]` を文字のまま出していたこと。
 *
 * このとき **データ側の検査（check_materials / check_explanations / check_seed）は
 * 全部通っていた。** DB に入る文字列としては正しく、壊れていたのは描画だけだったから。
 * 表示側には機械の検査が1つも無く、「画面の確認は毎回やる」という文章しか無かった。
 * それを門にするのがこのスクリプト。
 *
 * ## 何をするか
 *
 * jsdom を立てて、実データ**全件**（教材の explanation / detail、問題解説）を
 * 本物の `Markdown` / `Explanation` / `TermPop` で描き、DOM を見る。
 * 抜き取りではない。担当ごとに書き方がぶれるので、代表例だけ見ても落ちる。
 *
 * 用語集は API から来るので `fetch` をスタブし、**入力に出てくる `[[用語]]` と
 * 解説の `choices[].term` を全部返す**。こうすると「用語集にある語は必ず
 * ボタンになる」が検査できる。用語が用語集で解決するかどうかはここの仕事ではない
 * （それは `check_explanations.py` が見ている）。
 *
 * 見るもの:
 *
 *   1. 描画後の文字に `[[` `]]` `**` が残っていない（記法が素通しになっていない）
 *   2. `[[用語]]` の数 ＝ 用語ボタンの数（太字の中・表のセル・見出し・箇条書きを含む）
 *   3. 教材の図の行が `<img>` になり、その画像が `public/` に実在する
 *   4. 表の行（`|` で始まる行が2行以上）が `<table>` になっている
 *   5. 解説は4選択肢が描かれ、正解の行に `correct` が付き、`term` はボタンになる
 *   6. 用語ボタンを押すとポップが出る・説明が入る・**ページが移らない**。
 *      論点に結び付いた語だけ「この論点を学ぶ」が出る
 *   7. 用語集が未取得（null）の間も `[[` が文字として出ない
 *   8. 配信物に版の印 `dist/version.json` があり、`build`（コミットの短い ID）と
 *      `at`（時刻）を持つ（ビルドの出力がある環境だけで見る）
 *
 * error は終了コード1（デプロイを止める）、warning は0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** 教材の世代。後ろが勝つ（build_seed.py の MATERIAL_DIRS と同じ）。 */
const MATERIAL_DIRS = ['materials', 'materials_v2', 'materials_v3']
/** ポップの中身。用語集の実際の文言は見ないので固定でよい。 */
const BRIEF = '検査用の1行説明です。'

/** Markdown.tsx と同じ記法。ここがずれると検査が意味を失うので、写したことを明示しておく。 */
const TERM_RE = /\[\[([^\[\]\n]+)\]\]/g
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/
const FIGURE_PREFIX = '/figures/materials/'

type Material = { topic_id: number; term?: string; explanation?: string; detail?: string }
type Choice = { label: string; term: string | null; note: string }
type Expl = {
  question_id: string
  content_key: string
  correct?: string
  correct_reason: string
  choices: Choice[]
}

type Issue = { where: string; what: string; excerpt: string }

// ---------------------------------------------------------------- 入力を読む

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

/** 教材を v1 → v2 → v3 の後勝ちで合成する（build_seed.py の load_materials と同じ）。 */
function loadMaterials(dataDir: string): Map<number, Material> {
  const out = new Map<number, Material>()
  for (const sub of MATERIAL_DIRS) {
    const dir = path.join(dataDir, sub)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      for (const m of readJson(path.join(dir, name)).materials ?? []) out.set(m.topic_id, m)
    }
  }
  return out
}

/** 問題解説を読む（build_seed.py の read_explanations と同じ。後勝ち）。 */
function loadExplanations(dataDir: string): Map<string, Expl> {
  const out = new Map<string, Expl>()
  const dir = path.join(dataDir, 'question_explanations')
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    for (const e of readJson(path.join(dir, name)).explanations ?? []) {
      if (e.content_key) out.set(e.content_key, e)
    }
  }
  return out
}

/** 正解表。`2026r08-q97` → answer_keys["2026r08"]["97"]。 */
function loadAnswers(dataDir: string): (qid: string) => string | null {
  const keys = readJson(path.join(dataDir, 'answer_keys.json'))
  return (qid) => {
    const i = qid.lastIndexOf('-q')
    if (i < 0) return null
    return keys[qid.slice(0, i)]?.[qid.slice(i + 2)] ?? null
  }
}

// ------------------------------------------------- 入力から期待値を数える側

/** 行が図の画像行か（Markdown.tsx と同じ条件。置き場所が違うものは段落になる）。 */
function figureSrc(line: string): string | null {
  const m = IMAGE_RE.exec(line)
  return m && m[2].startsWith(FIGURE_PREFIX) ? m[2] : null
}

/** 本文に書かれた `[[用語]]`。画像行の中は行内記法として解釈されないので数えない。 */
function termRefs(text: string): string[] {
  const out: string[] = []
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || figureSrc(line)) continue
    for (const m of line.matchAll(TERM_RE)) out.push(m[1])
  }
  return out
}

/** 図の行の src 一覧。 */
function figureSrcs(text: string): string[] {
  const out: string[] = []
  for (const raw of (text ?? '').split('\n')) {
    const src = figureSrc(raw.trim())
    if (src) out.push(src)
  }
  return out
}

/** `|` で始まる行が2行以上続く塊の数。1つの塊が1つの表になるはず。 */
function tableRuns(text: string): number {
  const lines = (text ?? '').split('\n').map((l) => l.trim())
  let runs = 0
  let run = 0
  for (const line of lines) {
    if (line.startsWith('|')) run++
    else {
      if (run >= 2) runs++
      run = 0
    }
  }
  if (run >= 2) runs++
  return runs
}

function excerpt(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

// ------------------------------------------------------------------- jsdom

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  const g = globalThis as any
  // navigator は代入するとエラーになるので触らない（Node が持っているもので足りる）
  g.window = dom.window
  g.document = dom.window.document
  g.localStorage = dom.window.localStorage
  g.Node = dom.window.Node
  g.Event = dom.window.Event
  g.MouseEvent = dom.window.MouseEvent
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.HTMLElement = dom.window.HTMLElement
  g.getComputedStyle = dom.window.getComputedStyle
  g.requestAnimationFrame = (fn: any) => setTimeout(() => fn(Date.now()), 0)
  g.cancelAnimationFrame = (id: any) => clearTimeout(id)
  g.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

async function main(): Promise<number> {
  const started = Date.now()
  const argv = process.argv.slice(2)
  const di = argv.indexOf('--data')
  const dataDir = path.resolve(ROOT, di >= 0 ? argv[di + 1] : 'data/ip')
  const pi = argv.indexOf('--public')
  const publicDir = path.resolve(ROOT, pi >= 0 ? argv[pi + 1] : 'public')

  const materials = loadMaterials(dataDir)
  const explanations = loadExplanations(dataDir)
  const answerOf = loadAnswers(dataDir)
  const topics: { id: number; term: string }[] =
    readJson(path.join(dataDir, 'topics.json')).topics ?? []
  const topicIdOf = new Map(topics.map((t) => [t.term, t.id]))

  // --- 用語集（スタブ）。入力に出てくる語を全部返す ---------------------
  const terms = new Set<string>()
  for (const m of materials.values()) {
    for (const t of termRefs(m.explanation ?? '')) terms.add(t)
    for (const t of termRefs(m.detail ?? '')) terms.add(t)
  }
  for (const e of explanations.values()) {
    for (const t of termRefs(e.correct_reason ?? '')) terms.add(t)
    for (const c of e.choices ?? []) {
      if (c.term) terms.add(c.term)
      for (const t of termRefs(c.note ?? '')) terms.add(t)
    }
  }
  // topic_id は「この論点を学ぶ →」の出し分けを見るために付ける。
  // 実データと同じで、論点名に一致する語にだけ付く。
  const glossary = [...terms].sort().map((term) => ({
    term,
    brief: BRIEF,
    topicId: topicIdOf.get(term) ?? null,
  }))

  const dom = setupDom()
  const g = globalThis as any
  let openGlossary!: () => void
  const gate = new Promise<void>((r) => {
    openGlossary = r
  })
  let fetched = 0
  g.fetch = async (url: string) => {
    fetched++
    await gate
    const body = url.endsWith('/glossary') ? { glossary } : {}
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  // React の警告（key の重複など）は warning として拾う
  const consoleWarnings: string[] = []
  const realError = console.error
  console.error = (...a: any[]) => {
    consoleWarnings.push(String(a[0]).slice(0, 200))
  }

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { Markdown } = await import('../src/client/components/Markdown')
  const { Explanation } = await import('../src/client/components/Explanation')

  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  const wrap = (node: any) => h(MemoryRouter, { initialEntries: ['/'] }, node)
  const draw = async (node: any) => {
    await act(async () => {
      root.render(wrap(node))
    })
  }

  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (where: string, what: string, ex: string) => errors.push({ where, what, excerpt: ex })
  const warn = (where: string, what: string, ex: string) =>
    warnings.push({ where, what, excerpt: ex })

  // === 7. 用語集が未取得（null）でも `[[` が文字として出ない ==============
  // explanation に [[用語]] が 1 つも無い対象（mkt。用語は detail 側だけ）で fetch 未検出の誤報が出たので、
  // explanation → detail の順で用語を含む本文を探す（2026-09-15）
  const sampleText = (m: Material) =>
    termRefs(m.explanation ?? '').length > 0 ? m.explanation ?? '' : m.detail ?? ''
  const sample = [...materials.values()].find((m) => termRefs(sampleText(m)).length > 0)
  if (sample) {
    await draw(h(Markdown, { source: sampleText(sample) }))
    if (container.textContent!.includes('[[')) {
      err(`論点 ${sample.topic_id}`, '用語集が未取得の間に [[ が文字として出ている',
        excerpt(sampleText(sample)))
    }
    if (container.querySelectorAll('button.term-btn').length > 0) {
      err(`論点 ${sample.topic_id}`, '用語集が未取得なのにボタンが出ている', '')
    }
  }
  // 用語集を返す。以降は取得済みの状態で描く
  openGlossary()
  await act(async () => {})
  if (fetched === 0) {
    err('用語集', 'fetch が呼ばれていない（TermPop が用語集を取りに行っていない）', '')
  }

  // === 1〜4. 教材 =======================================================
  // 記法の解釈（1・4）・用語ポップ（2）・教材の図が試験ごとの場所に実在すること（3）
  let termTotal = 0
  let buttonTotal = 0
  let figureTotal = 0
  const missingFigures = new Set<string>()

  const checkText = async (where: string, source: string) => {
    if (!source) return
    await draw(h(Markdown, { source }))
    const text = container.textContent ?? ''

    // 1. 記法が素通しになっていない
    for (const mark of ['[[', ']]', '**']) {
      if (text.includes(mark)) {
        const at = text.indexOf(mark)
        err(where, `描画後に ${mark} が文字として残っている`,
          excerpt(text.slice(Math.max(0, at - 20), at + 40)))
      }
    }

    // 2. [[用語]] の数 ＝ ボタンの数
    const refs = termRefs(source)
    const buttons = container.querySelectorAll('button.term-btn').length
    termTotal += refs.length
    buttonTotal += buttons
    if (refs.length !== buttons) {
      err(where, `用語ボタンの数が合わない（[[…]] ${refs.length} 件 / ボタン ${buttons} 個）`,
        excerpt(refs.join(' / ')))
    }

    // 3. 図の行は <img> になり、画像が実在する
    const srcs = figureSrcs(source)
    const imgs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
    figureTotal += srcs.length
    if (srcs.length !== imgs.length) {
      err(where, `図の数が合わない（画像行 ${srcs.length} / <img> ${imgs.length}）`,
        excerpt(srcs.join(' / ')))
    }
    for (const src of imgs) {
      if (!fs.existsSync(path.join(publicDir, src))) {
        missingFigures.add(src)
        err(where, `図の画像が public/ に無い: ${src}`, '')
      }
    }

    // 4. 表の行は <table> になる
    const runs = tableRuns(source)
    const tables = container.querySelectorAll('table').length
    if (runs > tables) {
      err(where, `表が描かれていない（| で始まる塊 ${runs} / <table> ${tables}）`,
        excerpt(source.split('\n').find((l) => l.trim().startsWith('|')) ?? ''))
    }
    if (text.includes('|')) {
      warn(where, '描画後に | が残っている（表として組まれていない行がある）',
        excerpt(text.slice(Math.max(0, text.indexOf('|') - 20), text.indexOf('|') + 40)))
    }
  }

  for (const tid of [...materials.keys()].sort((a, b) => a - b)) {
    const m = materials.get(tid)!
    await checkText(`論点 ${tid}（${m.term ?? ''}）explanation`, m.explanation ?? '')
    await checkText(`論点 ${tid}（${m.term ?? ''}）detail`, m.detail ?? '')
  }

  // === 5. 問題解説 ======================================================
  const LABELS = ['ア', 'イ', 'ウ', 'エ']
  for (const ck of [...explanations.keys()].sort()) {
    const e = explanations.get(ck)!
    const where = `解説 ${ck}（${e.question_id}）`
    const answer = answerOf(e.question_id)
    const choices: Choice[] = (e.choices ?? []).map((c) => ({
      label: c.label,
      term: c.term ?? null,
      note: c.note ?? '',
    }))
    await draw(
      h(Explanation, {
        data: { correctReason: e.correct_reason ?? '', choices },
        answer,
      }),
    )
    const text = container.textContent ?? ''

    for (const mark of ['[[', ']]', '**']) {
      if (text.includes(mark)) {
        const at = text.indexOf(mark)
        err(where, `描画後に ${mark} が文字として残っている`,
          excerpt(text.slice(Math.max(0, at - 20), at + 40)))
      }
    }

    const rows = [...container.querySelectorAll('.expl-choice')]
    if (rows.length !== 4) {
      err(where, `選択肢が4行描かれていない（${rows.length} 行）`, excerpt(e.correct_reason ?? ''))
    }
    const correct = rows.filter((r) => r.classList.contains('correct'))
    if (answer === null) {
      err(where, '正解表に無い問題', e.question_id)
    } else if (correct.length !== 1) {
      err(where, `正解の行に correct が付いていない（answer=${answer} / correct ${correct.length} 行）`,
        excerpt(choices.map((c) => c.label).join('')))
    } else if (!(correct[0].textContent ?? '').startsWith(answer)) {
      err(where, `correct が別の行に付いている（answer=${answer}）`,
        excerpt(correct[0].textContent ?? ''))
    }
    if (LABELS.some((l) => !choices.find((c) => c.label === l))) {
      err(where, '選択肢の記号がア〜エに揃っていない', choices.map((c) => c.label).join('/'))
    }

    // term のある選択肢はボタンになる（＋本文の [[…]] も）
    const refs = [
      ...termRefs(e.correct_reason ?? ''),
      ...choices.flatMap((c) => termRefs(c.note)),
    ]
    const expected = refs.length + choices.filter((c) => c.term).length
    const buttons = container.querySelectorAll('button.term-btn').length
    termTotal += refs.length
    buttonTotal += buttons
    if (expected !== buttons) {
      err(where, `用語ボタンの数が合わない（期待 ${expected} / ボタン ${buttons}）`,
        excerpt(choices.map((c) => c.term).filter(Boolean).join(' / ')))
    }
  }

  // === 6. 押したときの挙動 ==============================================
  const withTopic = glossary.find((x) => x.topicId !== null)
  const withoutTopic = glossary.find((x) => x.topicId === null)
  for (const [kind, entry] of [
    ['論点あり', withTopic],
    ['論点なし', withoutTopic],
  ] as const) {
    if (!entry) continue
    const where = `用語ポップ（${kind}）${entry.term}`
    await draw(h(Markdown, { source: `本文の中の [[${entry.term}]] を押す。` }))
    const btn = container.querySelector('button.term-btn') as any
    if (!btn) {
      err(where, '用語がボタンになっていない', entry.term)
      continue
    }
    const before = dom.window.location.pathname
    await act(async () => {
      btn.click()
    })
    const card = dom.window.document.body.querySelector('.term-card')
    if (!card) {
      err(where, '押してもポップが出ない', entry.term)
      continue
    }
    if (!(card.textContent ?? '').includes(BRIEF)) {
      err(where, 'ポップに説明が入っていない', excerpt(card.textContent ?? ''))
    }
    if (dom.window.location.pathname !== before) {
      err(where, `用語を押したらページが移った（${before} → ${dom.window.location.pathname}）`, '')
    }
    const link = card.querySelector('a.term-link')
    if (entry.topicId !== null && !link) {
      err(where, '論点に結び付いた語なのに「この論点を学ぶ」が出ない', entry.term)
    }
    if (entry.topicId === null && link) {
      err(where, '論点に結び付いていない語に「この論点を学ぶ」が出ている', entry.term)
    }
    if (link && entry.topicId !== null && link.getAttribute('href') !== `/topics/${entry.topicId}`) {
      err(where, `リンク先が違う（${link.getAttribute('href')}）`, entry.term)
    }
    // 開いたままだと次の描画に残るので閉じる
    await act(async () => {
      btn.click()
    })
  }

  await act(async () => {
    root.unmount()
  })
  console.error = realError

  // === 8. 版の印（version.json）=========================================
  const stamp = checkVersionStamp()
  errors.push(...stamp.errors)
  warnings.push(...stamp.warnings)

  // --- 出力 -------------------------------------------------------------
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`描画検査 ${path.relative(ROOT, dataDir)}（${secs} 秒）`)
  console.log(`  論点 ${materials.size} 件 / 問題解説 ${explanations.size} 本`)
  console.log(`  用語 [[…]] ${termTotal} 件 → 用語ボタン ${buttonTotal} 個（用語集 ${glossary.length} 語）`)
  console.log(`  教材の図 ${figureTotal} 枚（画像が無いもの ${missingFigures.size} 種）`)

  for (const w of consoleWarnings.slice(0, 5)) console.log(`  [React の警告] ${w}`)
  if (consoleWarnings.length) console.log(`  React の警告 ${consoleWarnings.length} 件`)

  if (warnings.length) {
    console.log(`\n警告 ${warnings.length} 件:`)
    for (const w of warnings.slice(0, 30)) console.log(`  - ${w.where}: ${w.what}\n      ${w.excerpt}`)
    if (warnings.length > 30) console.log(`  …ほか ${warnings.length - 30} 件`)
  }

  if (errors.length) {
    console.error(`\nエラー ${errors.length} 件:`)
    for (const e of errors.slice(0, 50)) console.error(`  - ${e.where}: ${e.what}\n      ${e.excerpt}`)
    if (errors.length > 50) console.error(`  …ほか ${errors.length - 50} 件`)
    console.error(`\n描画検査: エラー ${errors.length} 件`)
    return 1
  }
  console.log('\n描画検査: 問題なし')
  return 0
}

/** 配信物に版の印（version.json）が入っているか。ビルドの出力がある環境で見る。
 *  build はコミットの短い ID、at は時刻として読める文字列であること。 */
function checkVersionStamp(): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const where = 'version.json'
  const dist = path.join(ROOT, 'dist')
  const file = path.join(dist, 'version.json')
  if (!fs.existsSync(dist)) {
    warnings.push({
      where,
      what: 'ビルドの出力（dist/）が無いので版の印を見られない（ビルドの後に回すこと）',
      excerpt: dist,
    })
    return { errors, warnings }
  }
  if (!fs.existsSync(file)) {
    errors.push({
      where,
      what: 'ビルドの出力に version.json が無い（配信のたびに版の印を出すこと）',
      excerpt: dist,
    })
    return { errors, warnings }
  }
  let data: any
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e) {
    errors.push({ where, what: 'version.json が JSON として読めない', excerpt: String(e).slice(0, 120) })
    return { errors, warnings }
  }
  const excerpt = JSON.stringify(data).slice(0, 120)
  if (typeof data?.build !== 'string' || !data.build.trim()) {
    errors.push({ where, what: 'build（コミットの短い ID）が無い', excerpt })
  }
  if (typeof data?.at !== 'string' || Number.isNaN(Date.parse(data.at))) {
    errors.push({ where, what: 'at（時刻）が無い、または時刻として読めない', excerpt })
  }
  return { errors, warnings }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)

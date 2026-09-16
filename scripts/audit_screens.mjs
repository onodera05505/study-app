#!/usr/bin/env node
/**
 * L5: 画面の検査 — 本物のブラウザ（Chromium）で全画面 × 全状態を機械採取する。
 *
 * 入口は scripts/audit_screens.sh（ビルドと wrangler dev の起動込み）。
 * ここは採取の本体で、すでに起きているアプリに対して撮るだけ。
 *
 *   node scripts/audit_screens.mjs --exam ip --base http://127.0.0.1:8787 [--out DIR] [--limit N]
 *
 * ## 何を撮るか（docs/検査観点カタログ.md の L5 が仕様の親）
 *
 *   画面     全ルート ＋ 未ログインのログイン画面 ＋ 存在しない URL。
 *            :id は実データから代表を選ぶ（教材が長い・図がある・表がある・重複バッジがある）
 *   アカウント 未ログイン / audit_new（空）/ audit_mid（学習途中・中断あり）/ audit_heavy（履歴多）
 *   画面幅   375×812 / 768×1024 / 1280×800
 *   配色     light / dark（colorScheme エミュレーション）
 *   特殊状態 読み込み中（API を 3 秒遅延）/ API 500 / ネットワーク断（abort）
 *   操作後   用語ポップ・アカウントメニュー・折りたたみ・解説・図の拡大・回答直後の正誤色
 *            押せるものは **押す前にフォーカスを当てたショットも1枚**（フォーカスリングの確認）
 *
 * ## 直積は撮らない
 *
 * 幅 × 配色は基準アカウント（audit_mid）で全部撮り、他のアカウントは 1280×light だけにする。
 * 全部を掛け合わせると千枚を超えて、見るほうが破綻する。**どの組合せを撮ったかは
 * manifest.json に必ず残す**ので、抜けは後から数えられる。
 *
 * ## 各ショットで記録するもの
 *
 *   PNG / console.error / console.warning / pageerror / 失敗したリクエスト
 *   ページ全体の横スクロール（hscroll: true は不合格候補。表・図は自分の枠内で
 *   スクロールするのが正で、ページ全体が横に伸びるのは崩れ）
 *   文字がはみ出た葉要素の数（overflow-x が auto/scroll のものは意図的として別に数える）
 *   axe-core の violation（各画面 × 1280 × light で 1 回）
 *
 * 失敗したショットは manifest に error として残して先へ進む。1枚こけても採取は止めない。
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixtures, apiCall } from './audit_fixtures.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AXE_PATH = join(ROOT, 'node_modules/axe-core/axe.min.js')
const TOKEN_KEY = 'study-app.token' // src/client/lib/api.ts と同じキー

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const has = (n) => argv.includes(n)

const EXAM = arg('--exam', 'ip')
const BASE = arg('--base', 'http://127.0.0.1:8787')
const SCRATCH =
  process.env.AUDIT_SCRATCH ||
  '/private/tmp/claude-501/-Users-yudai-develop-study-app/4c49c2b4-5303-447b-963c-f8403d8e6121/scratchpad'
const OUT = resolve(arg('--out', join(SCRATCH, 'audit', EXAM)))
const LIMIT = Number(arg('--limit', '0')) || 0
const CONCURRENCY = Number(arg('--concurrency', '4'))

const WIDTHS = [
  { w: 375, h: 812, label: '375' }, // スマホ
  { w: 768, h: 1024, label: '768' }, // タブレット（breakpoint 640 の上）
  { w: 1280, h: 800, label: '1280' }, // PC
]
const SCHEMES = ['light', 'dark']

// ---------------------------------------------------------------- 代表 ID の選定

/** 論点を全件ぶん取る。API の limit は 500 までなので、単元ごとに分けて取る。 */
async function allTopics(token) {
  const cats = (await apiCall(BASE, '/categories', { token })).categories
  const seen = new Set()
  const out = []
  for (const c of cats) {
    const rows = (await apiCall(BASE, `/topics?middleNo=${c.middleNo}&limit=500`, { token })).topics
    for (const t of rows) if (!seen.has(t.id)) (seen.add(t.id), out.push(t))
  }
  return out.sort((a, b) => b.questionCount - a.questionCount)
}

/** 実データから「見どころのある」論点を選ぶ。手で ID を書かない（回を足すとずれる）。
 *
 *  図がある問題は 1,100 問中 39 問しかない、といった具合に薄いので、
 *  **抜き取りではなく全件を舐める**（ローカルなら1論点あたり10ミリ秒程度で済む）。 */
async function pickTopics(token) {
  const all = await allTopics(token)

  const details = []
  const queue = [...all]
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (;;) {
        const t = queue.shift()
        if (!t) return
        try {
          details.push(await apiCall(BASE, `/topics/${t.id}`, { token }))
        } catch {
          /* 1件くらい取れなくても選定は続ける */
        }
      }
    }),
  )

  const isTable = (s) => !!s && /^\s*\|/m.test(s)
  const scored = details.map((d) => {
    const body = `${d.topic.explanation ?? ''}\n${d.topic.detail ?? ''}`
    return {
      id: d.topic.id,
      term: d.topic.term,
      middleNo: d.topic.middleNo,
      bodyLen: body.length,
      terms: (body.match(/\[\[/g) ?? []).length,
      figures: d.questions.filter((q) => q.figureImage).length,
      tables: d.questions.filter((q) => isTable(q.figureDescription)).length + (isTable(body) ? 1 : 0),
      dups: d.questions.filter((q) => (q.timesAsked ?? 1) > 1).length,
      questions: d.questions.length,
      explanations: d.questions.filter((q) => q.explanation).length,
    }
  })

  const best = (label, why, pred, key) => {
    const pool = scored.filter(pred)
    if (!pool.length) return null
    const top = pool.sort((a, b) => key(b) - key(a))[0]
    return { ...top, label, why }
  }
  const picks = [
    best('long', '教材が長い（読む負荷・折り返しの確認）', (t) => t.bodyLen > 0, (t) => t.bodyLen),
    best('figure', '図の画像がある問題を含む', (t) => t.figures > 0, (t) => t.figures * 1000 + t.bodyLen),
    best('table', '表の書き起こしがある（横スクロールの確認）', (t) => t.tables > 0, (t) => t.tables * 1000 + t.bodyLen),
    best('dup', '重複バッジが出る問題を含む', (t) => t.dups > 0, (t) => t.dups * 1000 + t.bodyLen),
    best('terms', '用語ポップが多い（ポップの配置確認）', (t) => t.terms > 0, (t) => t.terms),
    best('sparse', '過去問が少ない（情報量の少ない側）', (t) => t.questions > 0, (t) => -t.questions * 1000 - t.bodyLen),
  ].filter(Boolean)

  const out = []
  const used = new Set()
  for (const p of picks) {
    if (used.has(p.id)) continue
    used.add(p.id)
    out.push(p)
  }
  // 満たせなかった観点は「撮れなかった組合せ」として残す（黙って落とさない）。
  const missing = ['long', 'figure', 'table', 'dup', 'terms', 'sparse'].filter(
    (l) => !picks.some((p) => p.label === l),
  )
  return {
    picks: out,
    middleNo: out[0]?.middleNo ?? all[0]?.middleNo ?? 1,
    probed: details.length,
    total: all.length,
    missing,
  }
}

// ---------------------------------------------------------------- 操作（押した後の状態）

/**
 * 押せるものは **フォーカスを当てたショット** → **押した後のショット** の2枚を撮る。
 * target が見つからなければ skipped として manifest に残す（黙って落とさない）。
 */
const ACTIONS = [
  {
    name: 'account-menu',
    routeKey: 'home',
    desc: 'アカウントメニューを開く',
    target: (p) => p.locator('.account-btn'),
    perform: async (p) => {
      await p.locator('.account-btn').click()
      await p.locator('.account-menu').waitFor({ timeout: 3000 })
    },
  },
  {
    name: 'term-pop',
    routeKey: 'topic-terms',
    desc: '用語ポップを開く',
    target: (p) => p.locator('.term-btn').first(),
    perform: async (p) => {
      await p.locator('.term-btn').first().click()
      await p.locator('.term-card').waitFor({ timeout: 3000 })
    },
  },
  {
    name: 'detail-open',
    routeKey: 'topic-long',
    desc: '「詳しく解説」の折りたたみを開く',
    target: (p) => p.getByRole('button', { name: '詳しく解説' }),
    perform: async (p) => {
      await p.getByRole('button', { name: '詳しく解説' }).click()
      await p.locator('.md-detail').waitFor({ timeout: 3000 })
    },
  },
  {
    name: 'answer-explanation',
    routeKey: 'topic-long',
    desc: '「答えを見る」→「解説」を開く',
    target: (p) => p.getByRole('button', { name: '答えを見る' }).first(),
    perform: async (p) => {
      await p.getByRole('button', { name: '答えを見る' }).first().click()
      const expl = p.getByRole('button', { name: '解説', exact: true }).first()
      if (await expl.count()) {
        await expl.click()
        await p.locator('.expl').first().waitFor({ timeout: 3000 })
      }
    },
  },
  {
    name: 'figure-zoom',
    routeKey: 'topic-figure',
    // 拡大できる図は2種類ある（過去問の切り出し .figure-image と教材の図 .md-figure）。
    // ページの先頭に近いほうが押されるので、待つ相手も両方を見る。
    desc: '図を原寸に拡大する',
    target: (p) => p.locator('.figure-zoom').first(),
    perform: async (p) => {
      await p.locator('.figure-zoom').first().click()
      await p.locator('.figure-image.zoomed, .md-figure.zoomed').first().waitFor({ timeout: 3000 })
    },
  },
  {
    name: 'topics-filter',
    routeKey: 'topics-middle',
    desc: '理解度の絞り込みチップを押す',
    target: (p) => p.locator('.chip-f.check').first(),
    perform: async (p) => {
      await p.locator('.chip-f.check').first().click()
      await p.waitForTimeout(600)
    },
  },
  {
    name: 'answer-choice',
    routeKey: 'session',
    // 中断中のセッションは過去問実践（模試）。模試は本番と同じく1問ごとの正誤を
    // 出さずに次の問題へ進むので、`.verdict` を待つと必ずタイムアウトする。
    // 練習系（正誤が出る）と模試（出ない）のどちらでも撮れるよう、
    // 「正誤が出た」か「次の問題に進んだ」かのどちらかを待つ。
    desc: '1問答えた直後（練習系は正誤の色、模試は次の問題）',
    serial: true, // 実際に回答を送るので並列にしない
    target: (p) => p.locator('.choices button.choice').first(),
    perform: async (p) => {
      const before = (await p.locator('.exam-top .idx').textContent().catch(() => '')) ?? ''
      await p.locator('.choices button.choice').first().click()
      await p
        .waitForFunction(
          (was) => {
            if (document.querySelector('.verdict')) return true
            const idx = document.querySelector('.exam-top .idx')
            return !!idx && idx.textContent !== was
          },
          before,
          { timeout: 6000 },
        )
        .catch(() => {})
    },
  },
  {
    name: 'register-tab',
    routeKey: 'home',
    account: 'guest',
    desc: '新規登録タブに切り替える',
    target: (p) => p.getByRole('button', { name: '新規登録' }).first(),
    perform: async (p) => {
      await p.getByRole('button', { name: '新規登録' }).first().click()
      await p.waitForTimeout(400)
    },
  },
]

// ---------------------------------------------------------------- 採取

const axeSource = readFileSync(AXE_PATH, 'utf8')

function fileNameOf(s) {
  // 操作名まで入れないと、同じルートで2つの操作を撮ったときにファイルがぶつかる
  const parts = [s.account, s.routeKey, s.width, s.scheme, s.state]
  if (s.action) parts.splice(2, 0, s.action)
  return `${parts.join('__')}.png`.replace(/[^\w.\-]+/g, '_')
}

/** ページ全体の横スクロールと、はみ出した葉要素を数える。 */
const MEASURE = () => {
  const de = document.documentElement
  const scrollWidth = Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0)
  const clientWidth = de.clientWidth
  const leaves = []
  let overflowLeaves = 0
  let clippedLeaves = 0
  const wide = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > clientWidth + 1 && wide.length < 8) {
      wide.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className)).slice(0, 60),
        right: Math.round(r.right),
        text: (el.textContent ?? '').trim().slice(0, 40),
      })
    }
    if (el.children.length > 0) continue
    // インライン要素は clientWidth が 0 になる。比較しても意味が無いので外す。
    if (el.clientWidth === 0) continue
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX
      const intentional = ox === 'auto' || ox === 'scroll'
      overflowLeaves++
      if (!intentional) clippedLeaves++
      if (leaves.length < 8) {
        leaves.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && String(el.className)).slice(0, 60),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: ox,
          intentional,
          text: (el.textContent ?? '').trim().slice(0, 40),
        })
      }
    }
  }
  return {
    hscroll: scrollWidth > clientWidth + 1,
    scrollWidth,
    clientWidth,
    docHeight: de.scrollHeight,
    overflowLeaves,
    clippedLeaves,
    overflowSamples: leaves,
    widerThanViewport: wide,
    textLen: (document.body?.innerText ?? '').length,
    title: document.title,
    // 「読み込み中…」で止まったまま撮れていないかの判定に使う
    loadingText: /読み込み中|集計中/.test(document.body?.innerText ?? ''),
  }
}

async function shoot(browser, spec) {
  const started = Date.now()
  const rec = {
    file: fileNameOf(spec),
    route: spec.path,
    routeKey: spec.routeKey,
    routeNote: spec.routeNote ?? null,
    account: spec.account,
    width: spec.width,
    height: spec.height,
    scheme: spec.scheme,
    state: spec.state,
    action: spec.action ?? null,
    expectFailure: !!spec.expectFailure,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    axe: null,
    error: null,
  }
  let context
  try {
    context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height },
      colorScheme: spec.scheme,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    })
    if (spec.token) {
      await context.addInitScript(
        ([k, v]) => {
          try {
            localStorage.setItem(k, v)
          } catch {}
        },
        [TOKEN_KEY, spec.token],
      )
    }
    // axe は CSP（script-src 'self'）で addScriptTag が弾かれる。
    // 初期化スクリプトは CSP の外側で走るので、そちらから入れる。
    if (spec.axe) await context.addInitScript({ content: axeSource })

    const page = await context.newPage()
    page.on('console', (m) => {
      const t = m.type()
      if (t === 'error') rec.consoleErrors.push(m.text().slice(0, 300))
      else if (t === 'warning') rec.consoleWarnings.push(m.text().slice(0, 300))
    })
    page.on('pageerror', (e) => rec.pageErrors.push(String(e.message).slice(0, 300)))
    page.on('requestfailed', (r) =>
      rec.failedRequests.push({ url: r.url().replace(BASE, ''), status: null, why: r.failure()?.errorText ?? null }),
    )
    page.on('response', (r) => {
      if (r.status() >= 400) rec.failedRequests.push({ url: r.url().replace(BASE, ''), status: r.status() })
    })

    // 特殊状態は /api/* だけを触る。静的アセットは通す（画面自体は出したい）。
    if (spec.state === 'loading') {
      await page.route('**/api/**', async (route) => {
        await new Promise((r) => setTimeout(r, 3000))
        await route.continue()
      })
    } else if (spec.state === 'api500') {
      await page.route('**/api/**', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'サーバでエラーが発生しました' }),
        }),
      )
    } else if (spec.state === 'offline') {
      await page.route('**/api/**', (route) => route.abort('failed'))
    }

    const url = `${BASE}${spec.path}`
    if (spec.state === 'loading') {
      // 読み込み中の**瞬間**を撮る。networkidle を待つと 3 秒後の完了状態になってしまう。
      await page.goto(url, { waitUntil: 'commit', timeout: 20000 })
      await page.waitForTimeout(1500)
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
      await page.waitForTimeout(500) // 描画の落ち着き待ち
    }

    const shots = []
    if (spec.action) {
      const def = ACTIONS.find((a) => a.name === spec.action)
      const target = def.target(page)
      const n = await target.count().catch(() => 0)
      if (n === 0) {
        rec.error = `操作の対象が見つからない（${def.desc}）`
        rec.skipped = true
        rec.file = null // 撮れていないので manifest でもファイル名を名乗らない
      } else {
        // まずフォーカスだけ当てて1枚（フォーカスリングが見えるかの確認）
        await target.scrollIntoViewIfNeeded().catch(() => {})
        await target.focus().catch(() => {})
        await page.waitForTimeout(200)
        shots.push({ suffix: 'focus', rec: { ...rec, state: `${spec.state}-focus` } })
        await def.perform(page)
        await page.waitForTimeout(400)
      }
    }

    const take = async (r) => {
      const m = await page.evaluate(MEASURE)
      Object.assign(r, m)
      const file = fileNameOf(r)
      r.file = file
      const opts = { path: join(OUT, file), fullPage: true }
      // 極端に長いページ（過去問が20問並ぶ論点など）は上から 12000px で切る
      if (m.docHeight > 12000) {
        opts.clip = { x: 0, y: 0, width: spec.width, height: 12000 }
        r.clipped = true
      }
      await page.screenshot(opts)
    }

    const results = []
    for (const s of shots) {
      const r = { ...rec, ...s.rec, consoleErrors: [...rec.consoleErrors] }
      await take(r)
      r.ms = Date.now() - started
      results.push(r)
    }
    if (!rec.skipped) {
      await take(rec)
      if (spec.axe) {
        rec.axe = await page
          .evaluate(async () => {
            const r = await window.axe.run(document, {
              resultTypes: ['violations'],
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
            })
            return r.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              nodes: v.nodes.length,
              sample: v.nodes[0]?.html?.slice(0, 160) ?? null,
            }))
          })
          .catch((e) => ({ error: String(e).slice(0, 200) }))
      }
    }
    rec.ms = Date.now() - started
    results.push(rec)
    return results
  } catch (e) {
    rec.error = String(e?.message ?? e).slice(0, 300)
    rec.ms = Date.now() - started
    return [rec]
  } finally {
    await context?.close().catch(() => {})
  }
}

// ---------------------------------------------------------------- 行列を組む

function buildSpecs(fx, reps, middleNo) {
  const specs = []
  const topicRoutes = reps.map((r) => ({
    key: `topic-${r.label}`,
    path: `/topics/${r.id}`,
    note: `${r.term}（${r.why}）`,
  }))
  const bogus = '00000000-0000-4000-8000-000000000000'

  const accounts = [
    { key: 'guest', token: null },
    { key: 'audit_new', token: fx.audit_new.token, inprog: bogus, done: bogus },
    {
      key: 'audit_mid',
      token: fx.audit_mid.token,
      inprog: fx.audit_mid.inProgressSessionId ?? bogus,
      done: fx.audit_mid.completedSessionIds?.[0] ?? bogus,
    },
    {
      key: 'audit_heavy',
      token: fx.audit_heavy.token,
      inprog: bogus,
      done: fx.audit_heavy.completedSessionIds?.[0] ?? bogus,
    },
  ]
  const byKey = Object.fromEntries(accounts.map((a) => [a.key, a]))

  const routesFor = (a) => [
    { key: 'home', path: '/' },
    { key: 'topics', path: '/topics' },
    { key: 'topics-middle', path: `/topics?middleNo=${middleNo}` },
    ...topicRoutes,
    { key: 'practice', path: '/practice' },
    { key: 'exams', path: '/exams' },
    {
      key: 'session',
      path: `/sessions/${a.inprog}`,
      note: a.inprog === bogus ? '存在しないセッション（エラー状態）' : '中断中のセッション',
      expectFailure: a.inprog === bogus,
    },
    {
      key: 'result',
      path: `/sessions/${a.done}/result`,
      note: a.done === bogus ? '存在しないセッション（エラー状態）' : '完走した結果',
      expectFailure: a.done === bogus,
    },
    { key: 'history', path: '/history' },
    { key: 'feedback', path: '/feedback', note: 'フィードバック（要件 §5.5-4）。直前の画面を添えるチェックは /topics/:id の後に開くと出る' },
    { key: 'notfound', path: '/no-such-page-xyz', note: '存在しない URL（SPA のフォールバック）' },
  ]

  const push = (a, r, wd, scheme, state, extra = {}) =>
    specs.push({
      account: a.key,
      token: a.token,
      routeKey: r.key,
      routeNote: r.note ?? null,
      path: r.path,
      width: wd.w,
      height: wd.h,
      scheme,
      state,
      // 404 を出させるために組んだルート（存在しないセッション）と、
      // わざと壊した特殊状態は、失敗リクエストが出て当然。
      // 「見つけたい失敗」を数えるために印を付けて除ける。
      expectFailure: !!r.expectFailure || ['loading', 'api500', 'offline'].includes(state),
      ...extra,
    })

  // 基準アカウント（audit_mid）: 全ルート × 全幅 × 両配色
  const mid = byKey.audit_mid
  for (const r of routesFor(mid))
    for (const wd of WIDTHS)
      for (const sc of SCHEMES)
        push(mid, r, wd, sc, 'normal', {
          // axe は 1280 × light で 1 画面 1 回だけ
          axe: wd.w === 1280 && sc === 'light',
        })

  // 他のアカウント: 1280 × light のみ（状態の違いが見たいのであって、幅は mid で見ている）
  for (const key of ['audit_new', 'audit_heavy']) {
    const a = byKey[key]
    for (const r of routesFor(a)) push(a, r, WIDTHS[2], 'light', 'normal')
  }

  // 未ログイン。ログイン画面は全幅 × 両配色で撮る（最初に出る画面なので）。
  const guest = { ...byKey.guest, inprog: bogus, done: bogus }
  for (const wd of WIDTHS)
    for (const sc of SCHEMES)
      push(guest, { key: 'home', path: '/' }, wd, sc, 'normal', { axe: wd.w === 1280 && sc === 'light' })
  for (const r of [
    { key: 'topics', path: '/topics', note: '未ログインで深いリンクを開いた場合' },
    { key: 'notfound', path: '/no-such-page-xyz' },
  ])
    push(guest, r, WIDTHS[2], 'light', 'normal')

  // 特殊状態（読み込み中 / API 500 / ネットワーク断）。audit_mid で撮る。
  const stateRoutes = routesFor(mid).filter((r) =>
    ['home', 'topics', 'practice', 'exams', 'session', 'result', 'history', topicRoutes[0]?.key].includes(r.key),
  )
  for (const state of ['loading', 'api500', 'offline'])
    for (const r of stateRoutes) push(mid, r, WIDTHS[2], 'light', state)
  // 狭い画面でもエラー・読み込み中を見る（文言が折り返して崩れないか）
  for (const state of ['loading', 'api500'])
    for (const r of stateRoutes.slice(0, 3)) push(mid, r, WIDTHS[0], 'light', state)

  // 操作後の状態。フォーカスを当てた1枚が自動で足される。
  for (const def of ACTIONS) {
    const a = byKey[def.account ?? 'audit_mid']
    const all = routesFor(a)
    const r = all.find((x) => x.key === def.routeKey) ?? topicRoutes[0]
    const widths = def.serial ? [WIDTHS[2]] : [WIDTHS[2], WIDTHS[0]]
    for (const wd of widths)
      push({ ...a }, r, wd, 'light', 'action', { action: def.name, serial: !!def.serial })
  }

  return specs
}

// ---------------------------------------------------------------- 実行

async function main() {
  console.log(`▶ L5 画面の検査 — exam=${EXAM} base=${BASE}`)
  console.log(`  出力先: ${OUT}`)

  // 前回の PNG は消す（残っていると「今回撮れなかった」ものが撮れたように見える）
  if (existsSync(OUT) && !has('--keep')) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const fx = await buildFixtures(BASE, { log: (s) => console.log(s) })
  const { picks, middleNo, probed, total, missing } = await pickTopics(fx.audit_mid.token)
  console.log(`  代表の論点（全 ${total} 論点のうち ${probed} 件を読んで選定）:`)
  for (const p of picks) console.log(`    #${p.id} ${p.term} — ${p.why}`)
  if (missing.length) console.log(`    ! 該当する論点が無い観点: ${missing.join(', ')}`)

  let specs = buildSpecs(fx, picks, middleNo)
  if (LIMIT) specs = specs.slice(0, LIMIT)
  console.log(`▶ ${specs.length} 組合せを撮る（並列 ${CONCURRENCY}）`)

  const browser = await chromium.launch()
  const shots = []
  let done = 0
  const parallel = specs.filter((s) => !s.serial)
  const serial = specs.filter((s) => s.serial)

  const runOne = async (s) => {
    const rs = await shoot(browser, s)
    shots.push(...rs)
    done++
    if (done % 20 === 0) console.log(`  ${done}/${specs.length}`)
  }

  const queue = [...parallel]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const s = queue.shift()
        if (!s) return
        await runOne(s)
      }
    }),
  )
  // 実際にデータを書き換える操作（回答の送信）は最後に1つずつ
  for (const s of serial) await runOne(s)

  await browser.close()

  const sum = (f) => shots.reduce((n, s) => n + f(s), 0)
  // わざと壊した状態（API 500・断・存在しないセッション）を除いた分だけを「見つけたい失敗」として数える
  const real = (f) => shots.reduce((n, s) => n + (s.expectFailure ? 0 : f(s)), 0)
  const summary = {
    shots: shots.length,
    ok: shots.filter((s) => !s.error).length,
    errors: shots.filter((s) => s.error).length,
    hscroll: shots.filter((s) => s.hscroll).length,
    consoleErrors: real((s) => s.consoleErrors?.length ?? 0),
    consoleErrorsInBrokenStates: sum((s) => (s.expectFailure ? s.consoleErrors?.length ?? 0 : 0)),
    consoleWarnings: real((s) => s.consoleWarnings?.length ?? 0),
    pageErrors: real((s) => s.pageErrors?.length ?? 0),
    pageErrorsInBrokenStates: sum((s) => (s.expectFailure ? s.pageErrors?.length ?? 0 : 0)),
    failedRequests: real((s) => s.failedRequests?.length ?? 0),
    clippedLeaves: sum((s) => s.clippedLeaves ?? 0),
    axeRuns: shots.filter((s) => Array.isArray(s.axe)).length,
    axeViolations: sum((s) => (Array.isArray(s.axe) ? s.axe.length : 0)),
    axeViolationIds: [
      ...new Set(shots.flatMap((s) => (Array.isArray(s.axe) ? s.axe.map((v) => v.id) : []))),
    ].sort(),
    // 通常状態なのに「読み込み中…」のまま撮れてしまった＝無限スピナーの疑い
    stuckLoading: shots.filter((s) => !s.expectFailure && s.loadingText).length,
    // API が 500 で返る／ネットワークが切れているのに「読み込み中…」のまま。
    // 検査観点カタログ L5 が「無限スピナーは不合格」としている状態そのもの。
    spinnerOnError: shots.filter(
      (s) => ['api500', 'offline'].includes(s.state) && s.loadingText,
    ).length,
    skippedActions: shots.filter((s) => s.skipped).length,
  }

  const manifest = {
    exam: EXAM,
    base: BASE,
    takenAt: new Date().toISOString(),
    out: OUT,
    widths: WIDTHS,
    schemes: SCHEMES,
    accounts: Object.fromEntries(
      Object.entries(fx).map(([k, v]) => [
        k,
        { email: v.email, inProgressSessionId: v.inProgressSessionId ?? null, completedSessions: (v.completedSessionIds ?? []).length },
      ]),
    ),
    representativeTopics: picks,
    representativeMissing: missing,
    topicsProbed: { probed, total },
    actions: ACTIONS.map((a) => ({ name: a.name, desc: a.desc, route: a.routeKey })),
    summary,
    shots: shots.sort((a, b) => ((a.file ?? a.routeKey) < (b.file ?? b.routeKey) ? -1 : 1)),
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log('')
  console.log('── 結果 ─────────────────────────────')
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') || '(なし)' : v}`)
  console.log(`  manifest: ${join(OUT, 'manifest.json')}`)
  if (summary.hscroll > 0) {
    console.log('')
    console.log('  ページ全体に横スクロールが出たショット（不合格候補）:')
    for (const s of shots.filter((x) => x.hscroll).slice(0, 20))
      console.log(`    ${s.file}  ${s.scrollWidth} > ${s.clientWidth}`)
  }
  const noisy = shots.filter((s) => !s.expectFailure && (s.consoleErrors.length || s.pageErrors.length))
  if (noisy.length) {
    console.log('')
    console.log('  コンソールにエラーが出たショット（わざと壊した状態を除く）:')
    for (const s of noisy.slice(0, 20))
      console.log(`    ${s.file}: ${[...s.consoleErrors, ...s.pageErrors].slice(0, 2).join(' / ')}`)
  }
  if (summary.stuckLoading > 0) {
    console.log('')
    console.log('  通常状態なのに「読み込み中…」のまま撮れたショット（無限スピナーの疑い）:')
    for (const s of shots.filter((x) => !x.expectFailure && x.loadingText)) console.log(`    ${s.file}`)
  }
  if (summary.spinnerOnError > 0) {
    console.log('')
    console.log('  API 500 / 通信断なのに「読み込み中…」のまま（無限スピナー。L5 では不合格）:')
    for (const s of shots.filter((x) => ['api500', 'offline'].includes(x.state) && x.loadingText))
      console.log(`    ${s.file}`)
  }
  if (summary.errors > 0) {
    console.log('')
    console.log('  撮れなかった組合せ:')
    for (const s of shots.filter((x) => x.error))
      console.log(`    ${s.file ?? `${s.account}/${s.routeKey}/${s.action ?? s.state}/${s.width}`}: ${s.error}`)
  }
  if (missing.length) {
    console.log('')
    console.log(`  代表を選べなかった観点（このデータには該当する論点が無い）: ${missing.join(', ')}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

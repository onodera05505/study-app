#!/usr/bin/env node
// SVG を Chromium（Playwright）で、元の幅と高さのまま PNG に描く。build_learner_pack.py が呼ぶ。
//   引数: 1 つの図を描く待ち時間の上限（秒）
//   標準入力: [{"src": "<svg のパス>", "dst": "<png のパス>"}, ...]
//   標準出力: {"failed": [{"src": ..., "reason": ...}]}（描けなかった物だけ）
// 図は画像（img）として読み込んで描く。画像として読む SVG は、ブラウザが図の中の script を走らせず、
// 図のファイルの外の資源（http・隣のファイル・CSS の読み込み・フォント・use の参照先）を取りに行かない。
// 加えて、ページが出す要求は data: 以外をすべて断る。
// 画像として読めない SVG（xmlns の無い物・図でない XML など）は読み込みに失敗し、描けない図になる。
// 文字はブラウザの文字の描画で描くので、長音符・中黒などの字も手元の日本語の字形で欠かさず描ける。
// Chromium を起こせないときは終了コード 2 で、全件を failed に入れる。
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium } from 'playwright'

const timeoutMs = Math.max(1, Number(process.argv[2] ?? 30)) * 1000
const jobs = JSON.parse(readFileSync(0, 'utf-8'))
const failed = []
let browser
try {
  browser = await chromium.launch()
} catch (e) {
  for (const j of jobs) failed.push({ src: j.src, reason: `Chromium を起こせない: ${String(e.message ?? e).split('\n')[0]}` })
  process.stdout.write(JSON.stringify({ failed }))
  process.exit(2)
}

/** 図を画像（img）としてページに読み込む。ページが出す要求は data: 以外をすべて断る。 */
// @implements REQ-357
async function loadFigure(page, src) {
  await page.route('**/*', (route) => route.abort())
  const svg = readFileSync(src)
  const url = `data:image/svg+xml;base64,${svg.toString('base64')}`
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}img{display:block}</style></head>' +
      `<body><img id="fig" alt="" src="${url}"></body></html>`,
  )
}

/** 1 つの図を描く。読み込めない・幅か高さが無い・待ち時間の上限を超えた図は描けない図とする。 */
// @implements REQ-336
async function drawOne(context, src, dst) {
  const page = await context.newPage()
  let timer
  try {
    const work = (async () => {
      await loadFigure(page, src)
      const size = await page.evaluate(async () => {
        const img = document.getElementById('fig')
        await img.decode()
        return { w: img.naturalWidth, h: img.naturalHeight }
      })
      if (!size || size.w < 1 || size.h < 1) throw new Error('幅か高さが無い')
      await page.evaluate(({ w, h }) => {
        const img = document.getElementById('fig')
        img.style.width = `${w}px`
        img.style.height = `${h}px`
      }, size)
      mkdirSync(dirname(dst), { recursive: true })
      await page.locator('#fig').screenshot({ path: dst, type: 'png' })
    })()
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`描く待ち時間の上限（${timeoutMs / 1000} 秒）を超えた`)), timeoutMs)
    })
    await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
    await page.close().catch(() => {})
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 4000, height: 4000 }, deviceScaleFactor: 1 })
  for (const { src, dst } of jobs) {
    try {
      await drawOne(context, src, dst)
    } catch (e) {
      failed.push({ src, reason: String(e.message ?? e).split('\n')[0] })
    }
  }
} finally {
  await browser.close()
}
process.stdout.write(JSON.stringify({ failed }))

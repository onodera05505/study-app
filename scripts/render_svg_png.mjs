#!/usr/bin/env node
// SVG を Chromium（Playwright）で、元の幅と高さのまま PNG に描く。build_learner_pack.py が呼ぶ。
//   標準入力: [{"src": "<svg のパス>", "dst": "<png のパス>"}, ...]
//   標準出力: {"failed": [{"src": ..., "reason": ...}]}（描けなかった物だけ）
// ブラウザの文字の描画を使うので、長音符・中黒などの字も、SVG の font-family にある日本語の字形で欠かさず描ける。
// Chromium を起こせないときは終了コード 2 で、全件を failed に入れる。
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium } from 'playwright'

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
try {
  const page = await browser.newPage({ viewport: { width: 4000, height: 4000 } })
  for (const { src, dst } of jobs) {
    try {
      const svg = readFileSync(src, 'utf-8').replace(/^\s*<\?xml[^>]*\?>/, '')
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`)
      await page.evaluate(() => document.fonts.ready)
      const el = page.locator('body > svg').first()
      if ((await el.count()) === 0) throw new Error('svg の要素が無い')
      const box = await el.boundingBox()
      if (!box || box.width < 1 || box.height < 1) throw new Error('幅か高さが無い')
      mkdirSync(dirname(dst), { recursive: true })
      await el.screenshot({ path: dst, type: 'png' })
    } catch (e) {
      failed.push({ src, reason: String(e.message ?? e).split('\n')[0] })
    }
  }
} finally {
  await browser.close()
}
process.stdout.write(JSON.stringify({ failed }))

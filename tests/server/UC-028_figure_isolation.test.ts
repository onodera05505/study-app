import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildAsync, cleanWorkspaces, decodePng, figureFile, isPng, makeWorkspace, setupRewritten, solidPng, specFigure, whitish, writeSpec,
  type Run, type Ws,
} from './UC-028_fixture'

/** UC-028 単元の読み物の図を PNG に描くとき、図の中の script を走らせず、図のファイルの外の資源を取りに行かない（REQ-500）。
 *  観測するのは、手元に立てた HTTP の受け口が受けた要求と、描いた PNG の中央の画素だけ。
 *  図はどれも中央が白で、script が走るか外の資源が読まれると全面が黒で覆われる。 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

const OUT = 'readings/ip_21'

/** 中央を白で塗った 200×100 の図。 */
const isolatedSvg = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100"${attrs}>` +
  `<rect id="bg" width="200" height="100" fill="#ffffff"/>${inner}</svg>\n`

describe('UC-028 図の中の script を走らせず、図のファイルの外の資源を取りに行かずに描く（REQ-500）', () => {
  let server: Server
  let base = ''
  const hits: string[] = []
  let ws: Ws
  let r: Run
  /** 図の番号 → 図の中身と、その図だけが外へ出しうる要求の前置き。 */
  const variants: { kind: 'script' | 'outside'; label: string; prefix: string; svg: () => string; extra?: Record<string, Uint8Array> }[] = [
    { kind: 'script', label: 'script 要素が図を黒で覆い、外へ要求を出す', prefix: '/s1', svg: () => isolatedSvg(
      `<script type="text/javascript"><![CDATA[document.getElementById('bg').setAttribute('fill','#000000');fetch('${base}/s1-fetch');new Image().src='${base}/s1-image.png';]]></script>`) },
    { kind: 'script', label: '読み込みの属性（onload）が図を黒で覆い、外へ要求を出す', prefix: '/s2', svg: () => isolatedSvg('',
      ` onload="document.getElementById('bg').setAttribute('fill','#000000');fetch('${base}/s2-onload')"`) },
    { kind: 'script', label: '外の script を読む script 要素（xlink:href）', prefix: '/s3', svg: () => isolatedSvg(`<script xlink:href="${base}/s3-external.js"/>`) },
    { kind: 'outside', label: 'http の画像（image の href）', prefix: '/o1', svg: () => isolatedSvg(`<image href="${base}/o1-outer.png" width="200" height="100" preserveAspectRatio="none"/>`) },
    { kind: 'outside', label: 'http の画像（xlink:href）', prefix: '/o2', svg: () => isolatedSvg(`<image xlink:href="${base}/o2-outer.png" width="200" height="100" preserveAspectRatio="none"/>`) },
    { kind: 'outside', label: 'CSS の @import', prefix: '/o3', svg: () => isolatedSvg(`<style>@import url("${base}/o3-outer.css");</style>`) },
    { kind: 'outside', label: 'CSS の url() の塗り', prefix: '/o4', svg: () => isolatedSvg(`<style>#bg { fill: url("${base}/o4-outer.svg#p") }</style>`) },
    { kind: 'outside', label: 'use が指す外の図', prefix: '/o5', svg: () => isolatedSvg(`<use href="${base}/o5-outer.svg#all" />`) },
    { kind: 'outside', label: 'フォントの読み込み', prefix: '/o6', svg: () => isolatedSvg(`<style>@font-face { font-family: X; src: url("${base}/o6-outer.woff2"); } text { font-family: X }</style><text x="10" y="50">字</text>`) },
    { kind: 'outside', label: '同じ置き場の隣のファイル（相対の参照）', prefix: '', svg: () => isolatedSvg('<image href="uc028-black.png" width="200" height="100" preserveAspectRatio="none"/>'), extra: { 'uc028-black.png': solidPng(4, 4, [0, 0, 0]) } },
  ]
  let A = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const url = req.url ?? ''
      res.writeHead(200, { 'content-type': url.endsWith('.png') ? 'image/png' : url.endsWith('.css') ? 'text/css' : 'image/svg+xml' })
      res.end(url.endsWith('.png') ? solidPng(4, 4, [0, 0, 0]) : url.endsWith('.css') ? '#bg { fill: #000000 }' : isolatedSvg('<rect width="200" height="100" fill="#000000"/>'))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    ws = makeWorkspace('figure-isolation')
    const unit = setupRewritten(ws)
    const t = unit.at(0)
    A = t.id
    writeSpec(ws, t.id, t.term, variants.map((v, i) => specFigure(i + 1, 'explanation', `${t.stem}の隔たりを見る${i + 1}番目の図の説明文です。`)))
    variants.forEach((v, i) => {
      ws.write(figureFile(ws, `${t.id}-${i + 1}.svg`), v.svg())
      for (const [f, b] of Object.entries(v.extra ?? {})) ws.write(figureFile(ws, f), b)
    })
    r = await buildAsync(ws, { out: OUT })
  })
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    cleanWorkspaces()
  })

  /** 図が PNG に描かれ、中央の画素が白のまま（script も外の資源も描いていない）で、その図の要求が受け口に届いていない。 */
  function expectUntouched(i: number) {
    const v = variants[i]
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    const png = `figures/${A}-${i + 1}.png`
    expect(r.json.figures, v.label).toContain(png)
    const bytes = ws.bytes(`${OUT}/${png}`)
    expect(isPng(bytes), v.label).toBe(true)
    const img = decodePng(bytes)
    const center = img.at(Math.floor(img.width / 2), Math.floor(img.height / 2))
    expect(whitish(center), `${v.label}: 中央の画素 ${JSON.stringify(center)}`).toBe(true)
    if (v.prefix) expect(hits.filter((h) => h.startsWith(v.prefix)), v.label).toEqual([])
  }

  variants.forEach((v, i) => {
    if (v.kind !== 'script') return
    /** @covers REQ-500#script-not-run */
    it(`図に「${v.label}」があっても、script は走らず図は PNG に描かれて読み物が出来る`, () => expectUntouched(i))
  })
  variants.forEach((v, i) => {
    if (v.kind !== 'outside') return
    /** @covers REQ-500#outside-not-fetched */
    it(`図が「${v.label}」を指しても、取りに行かず図は PNG に描かれて読み物が出来る`, () => expectUntouched(i))
  })
})

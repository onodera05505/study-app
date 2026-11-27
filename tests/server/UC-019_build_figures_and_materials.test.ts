import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync, inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DELIVERED, DELIVERED_FILE, EDITED, EDITED_FILE, ROADMAP_FILE, UNITS,
  BUILD_SCRIPT, addFigureLine, build, copyFixture, dropBody, isPng, makeWorkspace, roadmapOf, snapshotFile, toolError,
  type Json, type Run, type Workspace,
} from './uc019_fixture'

/** UC-019 パックを作る入口（buildLearnerPack）のうち、配る本文の図を描くときの隔たり（REQ-357）・描けない図（REQ-336）・
 *  配る本文を選ぶ教材の世代のファイルが読めないとき（REQ-358）と、契約の例が指す作り物の置き場
 *  （tests/fixtures/learner-pack/<名前>/）から呼んだときの境界。
 *  観測するのは、標準出力の JSON と終了コード、出力先のパック、学びの置き場の eval の下の写し、
 *  図が外へ出す要求（手元に立てた HTTP の受け口が受けた数）、描いた PNG の画素だけ。 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const PACK = 'packs/c8'

/** 断ったときの共通の観測: 終了 1・コード・理由・出力先も写しも残らない。 */
function expectRefused(r: Run, ws: Workspace, code: string, opts: { out?: string; data?: string; cycle?: number } = {}) {
  const out = opts.out ?? PACK
  expect(r.status, r.stdout + r.stderr).toBe(1)
  expect(r.code, r.stdout).toBe(code)
  expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
  expect(ws.exists(out)).toBe(false)
  expect(ws.exists(`${opts.data ?? 'data/eng'}/eval/pack_cycle_${opts.cycle ?? 8}.json`)).toBe(false)
}
/** 図を描く間も手元の受け口が要求に応えられるよう、パックを作る入口を待たずに起こす。
 *  描き手が返らないときに試験全体が止まらないよう、図を描く待ち時間の上限（契約の renderTimeoutSeconds）を
 *  図の数だけ足した長さを超えたら打ち切り、終了コードを null として返す。 */
const BOUNDED_MS = 4 * 30_000 + 30_000
function buildBounded(ws: Workspace): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('python3', [BUILD_SCRIPT, '--data', 'data/eng', '--cycle', '8', '--out', PACK], { cwd: ws.dir })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), BOUNDED_MS)
    child.stdout.setEncoding('utf8').on('data', (x: string) => (stdout += x))
    child.stderr.setEncoding('utf8').on('data', (x: string) => (stderr += x))
    child.on('close', (status) => {
      clearTimeout(timer)
      let json: Json = undefined
      try {
        json = JSON.parse(stdout.trim())
      } catch {
        json = undefined
      }
      resolve({ status, stdout, stderr, json, code: toolError(json)?.code })
    })
  })
}
const figuresOf = (r: Run) =>
  ((toolError(r.json)?.figures ?? []) as Json[]).map((f) => ({ unit: f.unit, ref: f.ref })).sort((a, b) => `${a.unit}${a.ref}`.localeCompare(`${b.unit}${b.ref}`))

// ---- PNG を読み書きする最小の道具（8 ビット・インターレース無しの RGB / RGBA）。 ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
const chunk = (type: string, data: Uint8Array) => {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([u32(data.length), td, u32(crc32(td))])
}
/** 全面が 1 色の RGB の PNG。 */
function solidPng(w: number, h: number, rgb: [number, number, number]) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.concat([u32(w), u32(h), Uint8Array.of(8, 2, 0, 0, 0)])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
}
/** PNG の画素を読む。 */
function decodePng(b: Uint8Array): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const buf = Buffer.from(b)
  let p = 8
  let width = 0, height = 0, colorType = 0
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      expect(data[8], 'ビット深度').toBe(8)
      expect(data[12], 'インターレース').toBe(0)
    }
    if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= bpp ? px[y * stride + i - bpp] : 0
      const up = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c)
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      px[y * stride + i] = (x + pred) & 0xff
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + bpp)] }
}
/** 画素が白に近いか（RGB の各値が 200 以上。灰色 1 色の PNG は値 1 つ）。 */
const whitish = (v: number[]) => v.slice(0, Math.min(3, v.length)).every((c) => c >= 200)

/** 中央を白、その中を赤の帯で塗った 200×100 の図。script や外の資源が描く物は、黒で全面を覆う。 */
const isolatedSvg = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100"${attrs}>` +
  `<rect id="bg" width="200" height="100" fill="#ffffff"/>${inner}</svg>\n`

describe('UC-019 パックを作る: 図の隔たり・描けない図・教材の世代のファイル', () => {
  describe('図の中の script を走らせず、図のファイルの外の資源を取りに行かずに描く（REQ-357）', () => {
    let server: Server
    let base = ''
    const hits: string[] = []
    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(req.url ?? '')
        res.writeHead(200, { 'content-type': req.url?.endsWith('.png') ? 'image/png' : req.url?.endsWith('.css') ? 'text/css' : 'image/svg+xml' })
        res.end(req.url?.endsWith('.png') ? solidPng(4, 4, [0, 0, 0]) : req.url?.endsWith('.css') ? '#bg { fill: #000000 }' : isolatedSvg('<rect width="200" height="100" fill="#000000"/>'))
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      await new Promise<void>((done) => server.close(() => done()))
    })

    /** 図を 1 つ足して作り、その図の PNG を読む。 */
    async function drawOne(svg: string, extra: Record<string, string | Uint8Array> = {}) {
      const ws = makeWorkspace()
      ws.write('public/figures/materials/eng/iso/x-1.svg', svg)
      for (const [f, body] of Object.entries(extra)) ws.write(`public/figures/materials/eng/iso/${f}`, body)
      addFigureLine(ws, 4, '/figures/materials/eng/iso/x-1.svg')
      hits.length = 0
      const r = await buildBounded(ws)
      return { ws, r }
    }
    /** パックが出来て、足した図が PNG に描かれ、中央の画素が白のまま（script も外の資源も描いていない）。 */
    function expectDrawnUntouched({ ws, r }: { ws: Workspace; r: Run }) {
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json.files.figures).toContain('figures/iso/x-1.png')
      const bytes = ws.bytes(`${PACK}/figures/iso/x-1.png`)
      expect(isPng(bytes)).toBe(true)
      const img = decodePng(bytes)
      expect(whitish(img.at(Math.floor(img.width / 2), Math.floor(img.height / 2))), JSON.stringify(img.at(Math.floor(img.width / 2), Math.floor(img.height / 2)))).toBe(true)
      expect(hits).toEqual([])
    }

    const scripts: [string, () => string][] = [
      ['script 要素が図を黒で覆い、外へ要求を出す', () => isolatedSvg(
        `<script type="text/javascript"><![CDATA[document.getElementById('bg').setAttribute('fill','#000000');fetch('${base}/from-script');new Image().src='${base}/from-script-image.png';]]></script>`)],
      ['読み込みの属性（onload）が図を黒で覆い、外へ要求を出す', () => isolatedSvg('',
        ` onload="document.getElementById('bg').setAttribute('fill','#000000');fetch('${base}/from-onload')"`)],
      ['外の名前空間の script 要素（xlink:href で外の script を読む）', () => isolatedSvg(`<script xlink:href="${base}/external-script.js"/>`)],
    ]
    for (const [label, svg] of scripts) {
      /** @covers REQ-357#script-not-run */
      it(`図に「${label}」があっても、script は走らず図は PNG に描かれてパックが出来る`, async () => {
        expectDrawnUntouched(await drawOne(svg()))
      }, BOUNDED_MS + 10_000)
    }

    const externals: [string, () => string, Record<string, string | Uint8Array>?][] = [
      ['http の画像（image の href）', () => isolatedSvg(`<image href="${base}/outer.png" width="200" height="100" preserveAspectRatio="none"/>`)],
      ['http の画像（xlink:href）', () => isolatedSvg(`<image xlink:href="${base}/outer-xlink.png" width="200" height="100" preserveAspectRatio="none"/>`)],
      ['CSS の @import', () => isolatedSvg(`<style>@import url("${base}/outer.css");</style>`)],
      ['CSS の url() の塗り', () => isolatedSvg(`<style>#bg { fill: url("${base}/outer.svg#p") }</style>`)],
      ['use が指す外の図', () => isolatedSvg(`<use href="${base}/outer-use.svg#all" />`)],
      ['フォントの読み込み', () => isolatedSvg(`<style>@font-face { font-family: X; src: url("${base}/outer.woff2"); } text { font-family: X }</style><text x="10" y="50">字</text>`)],
      ['同じ置き場の隣のファイル（相対の参照）', () => isolatedSvg('<image href="black.png" width="200" height="100" preserveAspectRatio="none"/>'), { 'black.png': solidPng(4, 4, [0, 0, 0]) }],
    ]
    for (const [label, svg, extra] of externals) {
      /** @covers REQ-357#outside-not-fetched */
      it(`図が「${label}」を指しても、取りに行かず図は PNG に描かれてパックが出来る`, async () => {
        expectDrawnUntouched(await drawOne(svg(), extra))
      }, BOUNDED_MS + 10_000)
    }
  })

  describe('配る本文の図が XML として整わないか PNG に描けない（REQ-336）', () => {
    const notWellFormed: [string, string][] = [
      ['途中で切れた', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#ffffff"/><text x="10" y="40">途中'],
      ['要素が閉じない', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><g><rect width="240" height="60"/></svg>'],
      ['XML で決まっていない実体参照を含む', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="40">A&nbsp;B</text></svg>'],
      ['属性の引用符が閉じない', '<svg xmlns="http://www.w3.org/2000/svg" width="240 height="60"></svg>'],
    ]
    for (const [label, body] of notWellFormed) {
      /** @covers REQ-336#not-well-formed */
      it(`図が「${label}」SVG なら INTERNAL で止め、単位と図を挙げ、パックも写しも残さない`, () => {
        const ws = makeWorkspace()
        ws.write('public/figures/materials/eng/sub/2-1.svg', body)
        const r = build(ws)
        expectRefused(r, ws, 'INTERNAL')
        expect(figuresOf(r)).toEqual([{ unit: 2, ref: '/figures/materials/eng/sub/2-1.svg' }])
      })
    }

    /** @covers REQ-336#not-well-formed */
    it('作り物の置き場 figure-not-well-formed から作ると、整わない図の単位と図を挙げて INTERNAL で止める', () => {
      const ws = makeWorkspace()
      const root = copyFixture(ws, 'figure-not-well-formed')
      const data = `${root}/data/itc`
      const r = build(ws, { data, cycle: 1, out: 'packs/fx' })
      expectRefused(r, ws, 'INTERNAL', { out: 'packs/fx', data, cycle: 1 })
      expect(figuresOf(r)).toEqual([{ unit: 16, ref: '/figures/materials/itc/16-2.svg' }])
    })

    for (const [label, body] of [
      ['xmlns の無い SVG', '<svg width="240" height="60"><rect width="240" height="60" fill="#ffffff"/></svg>'],
      ['XML として整うが図でない', '<?xml version="1.0" encoding="UTF-8"?>\n<note>これは図ではない</note>\n'],
    ] as const) {
      /** @covers REQ-336#not-drawable */
      it(`図が「${label}」で PNG に描けなければ INTERNAL で止め、単位と図を挙げ、パックも写しも残さない`, () => {
        const ws = makeWorkspace()
        ws.write('public/figures/materials/eng/sub/2-1.svg', body)
        const r = build(ws)
        expectRefused(r, ws, 'INTERNAL')
        expect(figuresOf(r)).toEqual([{ unit: 2, ref: '/figures/materials/eng/sub/2-1.svg' }])
      })
    }

    /** @covers REQ-336#not-drawable */
    it('作り物の置き場 figure-not-drawable から作ると、描けない図の単位と図を挙げて INTERNAL で止める', () => {
      const ws = makeWorkspace()
      const root = copyFixture(ws, 'figure-not-drawable')
      const data = `${root}/data/itc`
      const r = build(ws, { data, cycle: 1, out: 'packs/fx' })
      expectRefused(r, ws, 'INTERNAL', { out: 'packs/fx', data, cycle: 1 })
      expect(figuresOf(r)).toEqual([{ unit: 16, ref: '/figures/materials/itc/16-1.svg' }])
    })
  })

  describe('配る本文を選ぶ教材の世代のファイルが読めない（REQ-358）', () => {
    const generations = [
      ['materials', 'data/eng/materials/bundle_02.json'],
      ['materials_v2', 'data/eng/materials_v2/bundle_01.json'],
      ['materials_v3', 'data/eng/materials_v3/bundle_09.json'],
    ] as const
    for (const [gen, file] of generations) {
      for (const [label, body] of [
        ['JSON として読めない', '{ "bundle": 2, "materials": [\n'],
        ['空のファイル', ''],
      ] as const) {
        /** @covers REQ-358#not-json */
        it(`${gen} の世代に「${label}」ファイルがあれば INVALID_INPUT で止め、そのファイルを挙げ、パックも写しも作らない`, () => {
          const ws = makeWorkspace()
          ws.write(file, body)
          const r = build(ws)
          expectRefused(r, ws, 'INVALID_INPUT')
          expect(toolError(r.json).unreadable).toEqual([file])
        })
      }
    }

    /** @covers REQ-358#not-json */
    it('作り物の置き場 materials-unreadable から作ると、読めない世代のファイルを挙げて INVALID_INPUT で止める', () => {
      const ws = makeWorkspace()
      const root = copyFixture(ws, 'materials-unreadable')
      const data = `${root}/data/itc`
      const r = build(ws, { data, cycle: 1, out: 'packs/fx' })
      expectRefused(r, ws, 'INVALID_INPUT', { out: 'packs/fx', data, cycle: 1 })
      expect(toolError(r.json).unreadable).toEqual([`${data}/materials_v3/bundle_02.json`])
    })

    for (const [label, row] of [
      ['topic_id の欄が無い', { term: '単位二', explanation: '説明', detail: '解説' }],
      ['topic_id が文字列', { topic_id: '2', term: '単位二', explanation: '説明', detail: '解説' }],
      ['topic_id が null', { topic_id: null, term: '単位二', explanation: '説明', detail: '解説' }],
    ] as const) {
      /** @covers REQ-358#row-without-topic-id */
      it(`教材の世代のファイルに「${label}」行があれば INVALID_INPUT で止め、そのファイルを挙げ、パックも写しも作らない`, () => {
        const ws = makeWorkspace()
        ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: [...DELIVERED, row] })
        const r = build(ws)
        expectRefused(r, ws, 'INVALID_INPUT')
        expect(toolError(r.json).unreadable).toEqual([DELIVERED_FILE])
      })
    }

    /** @covers REQ-358#overridden-file-still-checked */
    it('後の世代に上書きされて配る本文に選ばれない前の世代のファイルでも、topic_id の無い行があれば止める', () => {
      const ws = makeWorkspace()
      ws.write(EDITED_FILE, { bundle: 1, materials: [...EDITED, { term: '単位二', explanation: '説明', detail: '解説' }] })
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT')
      expect(toolError(r.json).unreadable).toEqual([EDITED_FILE])
    })

    /** @covers REQ-358#several-files-listed */
    it('読めないファイルが世代をまたいで複数あれば、すべて挙げる', () => {
      const ws = makeWorkspace()
      ws.write('data/eng/materials/bundle_02.json', '{ "materials": [')
      ws.write('data/eng/materials_v3/bundle_09.json', '')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT')
      expect([...toolError(r.json).unreadable].sort()).toEqual(['data/eng/materials/bundle_02.json', 'data/eng/materials_v3/bundle_09.json'])
    })

    /** @covers REQ-358#after-roadmap-row-broken */
    it('ロードマップに欠けた行もあるときは、ロードマップの行を挙げて止める（世代のファイルより先）', () => {
      const ws = makeWorkspace()
      ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 1 ? ({ ...u, term: undefined } as unknown as typeof u) : u))))
      ws.write('data/eng/materials/bundle_02.json', '{ "materials": [')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT')
      expect((toolError(r.json).roadmapRows as Json[]).map((x) => x.index)).toEqual([1])
      expect(toolError(r.json).unreadable).toBeUndefined()
    })

    /** @covers REQ-358#before-body-missing */
    it('配る本文の無い単位もあるときは、読めない世代のファイルを挙げて INVALID_INPUT で止める（配る本文の欠けより先）', () => {
      const ws = makeWorkspace()
      dropBody(ws, 9)
      ws.write('data/eng/materials/bundle_02.json', '{ "materials": [')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT')
      expect(toolError(r.json).unreadable).toEqual(['data/eng/materials/bundle_02.json'])
      expect(toolError(r.json).units).toBeUndefined()
    })
  })

  describe('契約の例が指す作り物の置き場から呼ぶ（既存の要件のクラスの、前置き付きの学びの置き場の点）', () => {
    /** 作り物を写して呼ぶ。 */
    const fromFixture = (name: string, key: string) => {
      const ws = makeWorkspace()
      const data = `${copyFixture(ws, name)}/data/${key}`
      return { ws, data, r: build(ws, { data, cycle: 1, out: 'packs/fx' }) }
    }

    /** @covers REQ-333#questions-missing-build */
    it('questions-missing: 今の確認問題が無ければ NOT_FOUND で止める', () => {
      const { ws, data, r } = fromFixture('questions-missing', 'itc')
      expectRefused(r, ws, 'NOT_FOUND', { out: 'packs/fx', data, cycle: 1 })
    })

    /** @covers REQ-333#questions-unreadable-build */
    it('questions-unreadable: 読めない確認問題の束を挙げて INVALID_INPUT で止める', () => {
      const { ws, data, r } = fromFixture('questions-unreadable', 'itc')
      expectRefused(r, ws, 'INVALID_INPUT', { out: 'packs/fx', data, cycle: 1 })
      expect(toolError(r.json).unreadable).toEqual([`${data}/roadmap_questions/bundle_01.json`])
    })

    /** @covers REQ-335#explain-terms-unreadable */
    it('explain-terms-unreadable: 読めない語の一覧を挙げて INVALID_INPUT で止める', () => {
      const { ws, data, r } = fromFixture('explain-terms-unreadable', 'eng')
      expectRefused(r, ws, 'INVALID_INPUT', { out: 'packs/fx', data, cycle: 1 })
      expect(toolError(r.json).unreadable).toEqual([`${data}/explain_terms.json`])
    })

    /** @covers REQ-338#required-field-missing */
    it('roadmap-row-broken: 4 番目の行の topic_id の欠けを挙げて INVALID_INPUT で止める', () => {
      const { ws, data, r } = fromFixture('roadmap-row-broken', 'itc')
      expectRefused(r, ws, 'INVALID_INPUT', { out: 'packs/fx', data, cycle: 1 })
      expect(toolError(r.json).roadmapRows).toEqual([{ index: 3, fields: ['topic_id'] }])
    })

    /** @covers REQ-319#unit-body-missing */
    it('body-missing: 配る本文の無い単位 12 を挙げて NOT_FOUND で止める', () => {
      const { ws, data, r } = fromFixture('body-missing', 'itc')
      expectRefused(r, ws, 'NOT_FOUND', { out: 'packs/fx', data, cycle: 1 })
      expect(toolError(r.json).units).toEqual([12])
    })

    /** @covers REQ-320#figure-missing */
    it('figure-missing: 画像の無い図を単位と組で挙げて NOT_FOUND で止める', () => {
      const { ws, data, r } = fromFixture('figure-missing', 'itc')
      expectRefused(r, ws, 'NOT_FOUND', { out: 'packs/fx', data, cycle: 1 })
      expect(figuresOf(r)).toEqual([{ unit: 12, ref: '/figures/materials/itc/12-1.svg' }])
    })

    /** @covers REQ-337#extension-only-differs */
    it('figure-name-collision: 同じ PNG の名前になる 2 つの図を単位と組で挙げて INVALID_INPUT で止める', () => {
      const { ws, data, r } = fromFixture('figure-name-collision', 'msg')
      expectRefused(r, ws, 'INVALID_INPUT', { out: 'packs/fx', data, cycle: 1 })
      expect(figuresOf(r)).toEqual([{ unit: 5, ref: '/figures/materials/msg/5-1.svg' }, { unit: 6, ref: '/figures/materials/msg/5-1.png' }])
    })

    /** @covers REQ-309#snapshot-file-and-response */
    it('作り物の置き場の学びでも、写しはその置き場の eval の下に残り、応答の snapshotPath がそれを指す', () => {
      const ws = makeWorkspace()
      const data = `${copyFixture(ws, 'figure-missing')}/data/itc`
      ws.write(`tests/fixtures/learner-pack/figure-missing/public/figures/materials/itc/12-1.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>')
      const r = build(ws, { data, cycle: 1, out: 'packs/fx' })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json.snapshotPath).toBe(`${data}/eval/pack_cycle_1.json`)
      expect(ws.exists(`${data}/eval/pack_cycle_1.json`)).toBe(true)
      expect(ws.exists(snapshotFile(1))).toBe(false)
    })
  })
})

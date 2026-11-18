/**
 * UC-028 の受け持ち（道具を回す buildUnitReading。outbound の read…・write… は持たない）。
 *
 * 入口（CLAUDE.md の「操作 → 入口」）: `scripts/build_unit_reading.py`。request の欄は欄の名前のままの長い名前の引数、
 * 作業ディレクトリは実例ごとの作業場所（kit/ta.ts）。登録簿はリポジトリの物。
 *
 * 前提（実例ごとに作る）:
 * - request の data が資格対策の学び ip を指すとき、置き場の根（前置き無しか tests/fixtures/unit-reading/<名前>/）に、
 *   リポジトリの data/ip（PDF とページの画像を除く）と public/figures/materials/ip を写す。
 * - 作り物の置き場（tests/fixtures/unit-reading/<名前>/）は、写した ip を例の名前の条件に当たるように書き換えて作る。
 *   書き換えは単元 21 の論点だけに、例の応答が挙げる論点・図・行・ファイルのとおりに行う（下の FIXTURE）。
 * - 出力先に中身がある例は、作業場所の docs に 1 つファイルを置く。
 */

import { readdir } from 'node:fs/promises'
import { defineHandler, Unanswerable, type ExampleLine } from '../kit/protocol'
import { inPlace, NOT_A_FIGURE, PNG_2X2, type Place } from '../kit/ta'

type Json = any

const UNIT = '21'
/** 書き直した世代（契約の ok の例が単元 21 の全論点に示す世代）。 */
const REWRITTEN = 'materials_v4'
const GENERATIONS = ['materials', 'materials_v2', 'materials_v3', 'materials_v4']
/** 単元 21 の、同時利用と障害に備えるまとまりの論点（学ぶ順）。 */
const LAST_GROUP = [34, 518, 372, 393, 197, 198, 368]

/** 置き場の根（作業場所からの相対。前置き無しは ''）の ip。 */
type Ip = { root: string; data: string; figure: (name: string) => string }

const ipOf = (root: string): Ip => {
  const prefix = root === '' ? '' : `${root}/`
  return { root, data: `${prefix}data/ip`, figure: (name) => `${prefix}public/figures/materials/ip/${name}` }
}

/** リポジトリの ip（PDF とページの画像を除く）と図の画像を、置き場の根へ写す。 */
async function copyIp(place: Place, ip: Ip) {
  await place.copyFromRepo('data/ip', ip.data, (rel) => rel === 'pdfs' || rel.startsWith('pdfs/') || rel === 'pages' || rel.startsWith('pages/'))
  await place.copyFromRepo('public/figures/materials/ip', ip.figure('').replace(/\/$/, ''))
}

/** その世代で論点の教材を持つファイル（作業場所からの相対）。 */
async function holders(place: Place, ip: Ip, gen: string, topicId: number): Promise<string[]> {
  const dir = `${ip.data}/${gen}`
  const out: string[] = []
  for (const name of (await readdir(place.abs(dir))).filter((n) => n.endsWith('.json')).sort()) {
    const j = await place.readJson(`${dir}/${name}`)
    if (((j.materials ?? []) as Json[]).some((m) => m?.topic_id === topicId)) out.push(`${dir}/${name}`)
  }
  return out
}

/** その世代から論点の教材を除く。 */
async function dropEntry(place: Place, ip: Ip, gen: string, topicId: number) {
  for (const f of await holders(place, ip, gen, topicId)) {
    const j = await place.readJson(f)
    j.materials = (j.materials as Json[]).filter((m) => m?.topic_id !== topicId)
    await place.writeJson(f, j)
  }
}

/** 書き直した世代の論点の教材を書き換える。 */
async function editRewritten(place: Place, ip: Ip, topicId: number, edit: (m: Json) => void) {
  const files = await holders(place, ip, REWRITTEN, topicId)
  if (files.length === 0) throw new Unanswerable(`前提を作れない: ${REWRITTEN} に論点 ${topicId} が無い`)
  for (const f of files) {
    const j = await place.readJson(f)
    for (const m of j.materials as Json[]) if (m?.topic_id === topicId) edit(m)
    await place.writeJson(f, j)
  }
}

const appendLine = (line: string) => (m: Json) => {
  m.detail = `${m.detail}\n${line}`
}

/** 書き直した世代から最後のまとまりの論点を除き、前の世代から選ばれるようにする（世代が混ざる）。 */
const mixed = async (p: Place, ip: Ip) => {
  for (const id of LAST_GROUP) await dropEntry(p, ip, REWRITTEN, id)
}
/** 論点 478 の教材をどの世代からも除く（配る本文が無い）。 */
const bodyMissing = async (p: Place, ip: Ip) => {
  for (const gen of GENERATIONS) await dropEntry(p, ip, gen, 478)
}
/** 論点 369 の 2 番目の図の画像を除く。 */
const figureMissing = (p: Place, ip: Ip) => p.remove(ip.figure('369-2.svg'))

/** 作り物の名前 → 置き場の書き換え。 */
const FIXTURE: Record<string, (place: Place, ip: Ip) => Promise<void>> = {
  'materials-unreadable': (p, ip) => p.write(`${ip.data}/${REWRITTEN}/${UNIT}-2.json`, '{ "materials": [\n'),
  'unit-plan-gate-stops': async (p, ip) => {
    const file = `${ip.data}/unit_plans/${UNIT}.json`
    const plan = await p.readJson(file)
    const key = String(plan.groups[1].topics[2])
    plan.prerequisites = { ...(plan.prerequisites ?? {}), [key]: [...(plan.prerequisites?.[key] ?? []), 999] }
    await p.writeJson(file, plan)
  },
  'body-missing': bodyMissing,
  'mixed-generations': mixed,
  'figure-missing': figureMissing,
  'figure-heading-missing': async (p, ip) => {
    await editRewritten(p, ip, 369, (m) => {
      const strip = (text: string) => text.split('\n').filter((l) => !/^!\[[^\]]*\]\(\/figures\/materials\/ip\/[^)]+\)\s*$/.test(l)).join('\n')
      m.explanation = strip(m.explanation)
      m.detail = strip(m.detail)
    })
    const spec = `${ip.data}/material_figures/369.json`
    const j = await p.readJson(spec)
    for (const f of j.figures as Json[]) if (f.id === 1) f.after = '### 本文に無い見出し'
    await p.writeJson(spec, j)
  },
  'figure-name-collision': async (p, ip) => {
    await editRewritten(p, ip, 278, appendLine('![衝突する図の説明文です。](/figures/materials/ip/369-1.png)'))
    await p.write(ip.figure('369-1.png'), PNG_2X2)
  },
  'figure-not-drawable': (p, ip) => p.write(ip.figure('32-1.svg'), NOT_A_FIGURE),
  'figure-line-malformed': async (p, ip) => {
    await editRewritten(p, ip, 369, appendLine('![図](/figures/materials/ip/../../zz-9.svg)'))
    await editRewritten(p, ip, 278, appendLine('![図](/figures/materials/IP/369-9.svg)'))
    await editRewritten(p, ip, 32, appendLine('![図](/figures/materials/369-9.svg)'))
  },
  'mixed-and-figure-line-malformed': async (p, ip) => {
    await mixed(p, ip)
    await editRewritten(p, ip, 369, appendLine('![図](/figures/materials/IP/369-9.svg)'))
  },
  'figure-line-malformed-and-figure-missing': async (p, ip) => {
    await editRewritten(p, ip, 369, appendLine('![図](/figures/materials/IP/369-9.svg)'))
    await figureMissing(p, ip)
  },
  'body-missing-and-mixed': async (p, ip) => {
    await bodyMissing(p, ip)
    await mixed(p, ip)
  },
  'mixed-and-figure-missing': async (p, ip) => {
    await mixed(p, ip)
    await figureMissing(p, ip)
  },
}

/** 例の名前ごとの、作り物のほかの前提。 */
const EXTRA: Record<string, (place: Place) => Promise<void>> = {
  outNotEmpty: (p) => p.write('docs/memo.txt', '既にある中身\n'),
  outNotEmptyBeforeUnitMissing: (p) => p.write('docs/memo.txt', '既にある中身\n'),
}

const CASES = new Set([
  'ok', 'badArguments', 'unknownLearning', 'roadmapLearning', 'outInsideData', 'outInsideOtherLearning', 'outNotEmpty', 'unitMissing',
  'materialsUnreadable', 'unitPlanGateStops', 'bodyMissing', 'mixedGenerations', 'figureMissing', 'figureHeadingMissing',
  'figureNameCollision', 'figureNotDrawable', 'abbreviatedArgument', 'figureLineMalformed', 'mixedBeforeFigureLineMalformed',
  'figureLineMalformedBeforeFigureMissing', 'badArgumentsBeforeRoadmap', 'roadmapBeforeOutInside', 'outInsideBeforeOutNotEmpty',
  'outNotEmptyBeforeUnitMissing', 'bodyMissingBeforeMixed', 'mixedBeforeFigureMissing',
])

async function prepare(place: Place, line: ExampleLine) {
  const data = String(line.request?.data ?? '')
  const m = /^(?:(tests\/fixtures\/unit-reading\/([a-z0-9-]+))\/)?data\/ip$/.exec(data)
  if (m) {
    const ip = ipOf(m[1] ?? '')
    await copyIp(place, ip)
    if (m[2] !== undefined) {
      const rewrite = FIXTURE[m[2]]
      if (!rewrite) throw new Unanswerable(`${line.case}: 作り物 ${m[2]} の作り方を決められない`)
      await rewrite(place, ip)
    }
  }
  await EXTRA[line.case]?.(place)
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-028',
  parallel: true,
  operations: {
    buildUnitReading: (line) => {
      if (!CASES.has(line.case)) throw new Unanswerable(`${line.operation}.${line.case}: 前提を決められない例の名前`)
      return inPlace(line, 'build_unit_reading.py', (place) => prepare(place, line))
    },
  },
})

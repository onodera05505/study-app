/**
 * UC-030 の受け持ち（ロードマップ型の学びの組み立ての道具の入口 3 つ。local-store inbound）。
 *
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行（`scripts/<操作名を snake_case にした名前>.py`）。
 * 引数は request の各欄と同じ名前（applySummaryOverride の id と summary は、同じ順で組にして値ごとに名前を繰り返す）。
 * 道具は実例ごとの影の根（kit/td.ts の projectShadow）を cwd にして回す。
 *
 * 前提（例の名前と契約の errors の when から）:
 * - data/<学び> を指す例は、リポジトリのその学びの写し
 * - tests/fixtures/<名前>/<学び> を指す例は、リポジトリにその fixture があれば写す。buildTargetDataset の fixture
 *   （roadmap-dataset-*）がリポジトリに無いときは、学びの写しを同じ相対パスに置き、例の名前が示す 1 つ（両方の例は 2 つ）の
 *   状態にする: 教材の無い単位（教材の束から 1 単位の教材を外す）・確認問題の数が違う単位（1 単位の確認問題を 1 つ外す）・
 *   登録簿の段に無い印の単位（印を段の最大より 1 大きくする）・副題が空の単位・ロードマップのデータが無い（roadmap.json を外す）
 * - buildTargetDataset の unknownLearning は、登録簿に無い学びの置き場を、組み立てに要る物がそろった学び itc の写しとして置く
 * - buildRoadmap の candidatesMissing は、ロードマップの設定だけを持つ fixture（論点の候補のファイルが無い）
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHandler, type ExampleLine, type Operation } from '../kit/protocol'
import { REPO_ROOT } from '../kit/tool'
import { answerOf, argsOf, inShadow, unknownCase, type ProjectShadow } from '../kit/td'

type Json = Record<string, any>

const py = (script: string, args: string[]) => ['python3', `scripts/${script}`, ...args]

/** request の data が指す置き場の、リポジトリでの在り方。 */
function placeOf(line: ExampleLine): { data: string; key: string; fixture: string | null } {
  const data = String(line.request?.data ?? 'data/itc')
  const key = data.split('/').pop() ?? ''
  return { data, key, fixture: data.startsWith('tests/') ? data : null }
}

/** 置き場を前提どおりに置いて道具を回す。body は、リポジトリに無い fixture の置き場を学びの写しから作ったあとに前提を足す物（足す物が無ければ null）。 */
async function withPlace(line: ExampleLine, body: ((s: ProjectShadow, data: string, key: string) => Promise<void>) | null, script: string, args: string[]) {
  const { data, key, fixture } = placeOf(line)
  const inRepo = fixture !== null && existsSync(join(REPO_ROOT, fixture))
  return inShadow({ learnings: fixture ? [] : [key], copy: inRepo ? [fixture] : [] }, async (s) => {
    if (fixture && !inRepo) {
      await s.learning(key, '__copy__')
      await mkdir(s.path(join(fixture, '..')), { recursive: true })
      await rename(s.path('data/__copy__'), s.path(fixture))
      if (body) await body(s, data, key)
    }
    return answerOf(await s.run(py(script, args)))
  })
}

const bundleFiles = async (s: ProjectShadow, data: string, sub: string) =>
  (await readdir(s.path(`${data}/${sub}`))).filter((n) => n.endsWith('.json')).sort().map((n) => `${data}/${sub}/${n}`)

/** 学ぶ順に並べたロードマップの単位。 */
const unitsOf = async (s: ProjectShadow, data: string): Promise<Json[]> =>
  [...((await s.readJson(`${data}/roadmap.json`)).units as Json[])].sort((a, b) => a.order - b.order)

async function dropMaterial(s: ProjectShadow, data: string, id: number) {
  for (const rel of await bundleFiles(s, data, 'materials')) {
    const body = await s.readJson(rel)
    body.materials = (body.materials as Json[]).filter((m) => m.topic_id !== id)
    await s.writeJson(rel, body)
  }
}

async function dropOneQuestion(s: ProjectShadow, data: string, id: number) {
  for (const rel of await bundleFiles(s, data, 'roadmap_questions')) {
    const body = await s.readJson(rel)
    const i = (body.questions as Json[]).findIndex((q) => q.topic_id === id)
    if (i < 0) continue
    body.questions = (body.questions as Json[]).filter((_, j) => j !== i)
    await s.writeJson(rel, body)
    return
  }
  throw new Error(`前提: 単位 ${id} の確認問題が無い`)
}

async function setUnitField(s: ProjectShadow, data: string, id: number, field: string, value: unknown) {
  const roadmap = await s.readJson(`${data}/roadmap.json`)
  const unit = (roadmap.units as Json[]).find((u) => u.topic_id === id)
  if (!unit) throw new Error(`前提: 単位 ${id} がロードマップに無い`)
  unit[field] = value
  await s.writeJson(`${data}/roadmap.json`, roadmap)
}

/** 登録簿のその学びの印の段の最大より 1 大きい印。 */
function tierOutside(key: string): number {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Json
  const levels = ((registry[key]?.roadmapSpec?.tiers ?? []) as Json[]).map((t) => Number(t.level))
  if (levels.length === 0) throw new Error(`前提: 登録簿の ${key} に印の段が無い`)
  return Math.max(...levels) + 1
}

const buildRoadmap: Operation = (line) => {
  const known = ['ok', 'candidatesMissing', 'unknownConfigId', 'duplicateTerm', 'unknownGrouping', 'chapterMissing', 'tierOutsideRegistry', 'includedAndExcluded', 'unknownConfigIdBeforeDuplicateTerm']
  if (!known.includes(line.case)) unknownCase(line)
  const { fixture } = placeOf(line)
  if (fixture && !existsSync(join(REPO_ROOT, fixture))) unknownCase(line)
  return withPlace(line, null, 'build_roadmap.py', argsOf(line.request))
}

const applySummaryOverride: Operation = (line) => {
  if (!['ok', 'countMismatch', 'unknownId', 'countMismatchBeforeUnknownId'].includes(line.case)) unknownCase(line)
  return withPlace(line, null, 'apply_summary_override.py', argsOf(line.request, { repeated: ['id', 'summary'] }))
}

const DATASET_PREMISE: Record<string, (s: ProjectShadow, data: string, key: string) => Promise<void>> = {
  ok: async () => {},
  roadmapMissing: async (s, data) => rm(s.path(`${data}/roadmap.json`)),
  materialMissing: async (s, data) => dropMaterial(s, data, (await unitsOf(s, data))[9].topic_id),
  questionCount: async (s, data) => dropOneQuestion(s, data, (await unitsOf(s, data))[2].topic_id),
  tierOutsideRegistry: async (s, data, key) => setUnitField(s, data, (await unitsOf(s, data))[3].topic_id, 'tier', tierOutside(key)),
  blankSubtitle: async (s, data) => setUnitField(s, data, (await unitsOf(s, data))[3].topic_id, 'subtitle', ''),
  materialMissingBeforeQuestionCount: async (s, data) => {
    const units = await unitsOf(s, data)
    await dropOneQuestion(s, data, units[2].topic_id)
    await dropMaterial(s, data, units[9].topic_id)
  },
}

const buildTargetDataset: Operation = (line) => {
  if (line.case === 'unknownLearning') {
    // 登録簿に無い学びの置き場は、組み立てに要る物がそろった学び itc の写しとして置く（登録簿だけで断るかを見る）
    const { key } = placeOf(line)
    return inShadow({}, async (s) => {
      await s.learning('itc', key)
      return answerOf(await s.run(py('build_target_dataset.py', argsOf(line.request))))
    })
  }
  const premise = DATASET_PREMISE[line.case]
  if (!premise) unknownCase(line)
  return withPlace(line, premise, 'build_target_dataset.py', argsOf(line.request))
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-030',
  parallel: true,
  operations: { buildRoadmap, applySummaryOverride, buildTargetDataset },
})

/** ロードマップ型の単位の名前と副題を、投入データの組み立て（`python3 scripts/build_target_dataset.py --data data/<学び>`）から
 *  論点の並び（UC-002 の listTopics ＝ GET /api/topics）と論点の教材（getTopicDetail ＝ GET /api/topics/{id}）の応答まで、
 *  分けたまま運ぶこと。UC-009
 *
 *  学びの置き場は日で束ねる学び（itc）の写しを一時の作業場に置き、ロードマップのデータ（roadmap.json の units）の
 *  1 単位にだけ副題を書き足す。名前（term）には手を入れない。組み立ては作業場を cwd にしてコマンドとして呼び、
 *  観測するのは終了コードと、組み立てが書いた投入データ（data/itc/topics.json の topics）だけ。
 *  応答の側は、同じ投入データから投入の SQL を作る入口（`python3 scripts/build_seed.py --data data/itc`）を呼び、
 *  migrations を当てた SQLite にその SQL を流してから HTTP の境界で叩く（DB の列には直接触らない）。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import { learningD1, sqliteOf } from '../portal/repay_UC-014_sqlite_d1'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILD = path.join(ROOT, 'scripts', 'build_target_dataset.py')
const SEED = path.join(ROOT, 'scripts', 'build_seed.py')
const LEARNING = 'itc'
const SECRET = 'test-secret'
const USER = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }

type Json = Record<string, any>

/** 副題を書き足す単位（学ぶ順 1 番）と、その副題。 */
const WITH_SUBTITLE = { order: 1, subtitle: '経営の課題を IT で解く役割' }
/** 副題を持たない単位。名前に括弧書きを含む単位（切り出さないことを見る点）と、含まない単位。 */
const PLAIN_ORDERS = [3, 5]

let ws: string
let roadmapUnits: Json[]
let build: { status: number | null; out: string }
let dataset: Json[] = []
let d1: D1Database | null = null
let seedError = ''

const run = (script: string) => {
  const r = spawnSync('python3', [script, '--data', `data/${LEARNING}`], { cwd: ws, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const unitOf = (order: number) => {
  const u = roadmapUnits.find((x) => x.order === order)
  if (!u) throw new Error(`ロードマップのデータに学ぶ順 ${order} の単位が無い（この検査は空振りになる）`)
  return u
}

/** 投入データの中の、その名前の論点（名前は元の文字のまま入るはずなので名前で引く）。 */
const datasetOf = (term: string) => {
  const t = dataset.filter((x) => x.term === term)
  expect(t, `投入データに名前「${term}」の論点がちょうど 1 つない`).toHaveLength(1)
  return t[0]
}

beforeAll(async () => {
  ws = fs.mkdtempSync(path.join(tmpdir(), 'uc009-subtitle-'))
  fs.cpSync(path.join(ROOT, 'data', LEARNING), path.join(ws, 'data', LEARNING), { recursive: true })
  // 教材の図は作業場の public の下から読まれる（無いと組み立てが止まる）
  const figures = path.join(ROOT, 'public', 'figures', 'materials', LEARNING)
  if (fs.existsSync(figures))
    fs.cpSync(figures, path.join(ws, 'public', 'figures', 'materials', LEARNING), { recursive: true })
  const file = path.join(ws, 'data', LEARNING, 'roadmap.json')
  const roadmap = JSON.parse(fs.readFileSync(file, 'utf8'))
  roadmapUnits = roadmap.units
  for (const u of roadmapUnits) delete u.subtitle
  unitOf(WITH_SUBTITLE.order).subtitle = WITH_SUBTITLE.subtitle
  fs.writeFileSync(file, JSON.stringify(roadmap, null, 2))

  build = run(BUILD)
  if (build.status === 0) {
    dataset = JSON.parse(fs.readFileSync(path.join(ws, 'data', LEARNING, 'topics.json'), 'utf8')).topics
    const seed = run(SEED)
    if (seed.status !== 0) seedError = `投入の SQL を作れない: ${seed.out}`
    else {
      d1 = await learningD1()
      const db = sqliteOf(d1)
      db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
        USER.id,
        `${USER.id}@example.com`,
        USER.name,
        '-',
        USER.role,
      )
      try {
        db.exec(fs.readFileSync(path.join(ws, 'data', LEARNING, 'seed.sql'), 'utf8'))
      } catch (e) {
        seedError = `投入の SQL を流せない: ${String(e)}`
      }
    }
  }
})

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
})

const expectBuilt = () => expect(build.status, `組み立てが終了 0 で終わらない:\n${build.out}`).toBe(0)

describe('投入データの組み立て（UC-009）', () => {
  // @covers REQ-414#subtitle-carried-apart
  it('ロードマップのデータで副題を持つ単位は、投入データでも名前と副題がそれぞれ元の文字のまま分かれて入る', () => {
    expectBuilt()
    const u = unitOf(WITH_SUBTITLE.order)
    const t = datasetOf(u.term)
    expect(t.subtitle, '副題が元の文字のまま入っていない').toBe(WITH_SUBTITLE.subtitle)
    expect(String(t.term), '名前に副題が混ざっている').not.toContain(WITH_SUBTITLE.subtitle)
  })

  // @covers REQ-414#no-subtitle-none
  it('副題を持たない単位は、投入データで副題を持たず、名前も元の文字のまま入る（括弧書きを含む名前も切り出さない）', () => {
    expectBuilt()
    expect(unitOf(5).term, '仕込み: 括弧書きを含む名前の単位でない').toMatch(/（.+）/)
    for (const order of PLAIN_ORDERS) {
      const t = datasetOf(unitOf(order).term)
      expect(t.subtitle ?? null, `学ぶ順 ${order} の副題を持たない単位に副題が付いている`).toBeNull()
    }
  })
})

async function get(p: string) {
  if (!d1) throw new Error(`応答を叩く前の投入ができていない（この検査は空振りになる）: ${build.out}\n${seedError}`)
  if (seedError) throw new Error(seedError)
  const token = await issueToken(SECRET, USER)
  const res = await app.request(
    p,
    { headers: { Authorization: `Bearer ${token}` } },
    { EXAM: LEARNING, JWT_SECRET: SECRET, DB: d1 } as unknown as Bindings,
  )
  const text = await res.text()
  expect(res.status, `${p} が 200 でない: ${text}`).toBe(200)
  return JSON.parse(text) as Json
}

/** 並びの応答の中の、その名前の単位。 */
async function listed(term: string) {
  const body = await get('/api/topics')
  const t = (body.topics as Json[]).filter((x) => x.term === term)
  expect(t, `論点の並びに名前「${term}」の単位がちょうど 1 つない`).toHaveLength(1)
  return t[0]
}

describe('副題を分けて返す（UC-009）', () => {
  // @covers REQ-413#list-name-and-subtitle-apart
  it('論点の並びで、副題が投入された単位は term が名前だけ、subtitle がその副題として返る', async () => {
    const u = unitOf(WITH_SUBTITLE.order)
    const t = await listed(u.term)
    expect(t).toHaveProperty('subtitle', WITH_SUBTITLE.subtitle)
  })

  // @covers REQ-413#list-no-subtitle-null
  it('論点の並びで、副題が投入されていない単位は subtitle が null で、term は名前のまま返る', async () => {
    for (const order of PLAIN_ORDERS) {
      const t = await listed(unitOf(order).term)
      expect(t, `学ぶ順 ${order}: 副題が無いことが subtitle: null として返っていない`).toHaveProperty('subtitle', null)
    }
  })

  // @covers REQ-413#detail-name-and-subtitle-apart
  it('論点の教材で、副題が投入された論点は term が名前だけ、subtitle がその副題として返る', async () => {
    const u = unitOf(WITH_SUBTITLE.order)
    const id = (await listed(u.term)).id
    const body = await get(`/api/topics/${id}`)
    expect(body.topic.term, '名前が名前だけになっていない').toBe(u.term)
    expect(body.topic).toHaveProperty('subtitle', WITH_SUBTITLE.subtitle)
  })

  // @covers REQ-413#detail-no-subtitle-null
  it('論点の教材で、副題が投入されていない論点は subtitle が null で、term は名前のまま返る', async () => {
    for (const order of PLAIN_ORDERS) {
      const u = unitOf(order)
      const id = (await listed(u.term)).id
      const body = await get(`/api/topics/${id}`)
      expect(body.topic.term).toBe(u.term)
      expect(body.topic, `学ぶ順 ${order}: 副題が無いことが subtitle: null として返っていない`).toHaveProperty('subtitle', null)
    }
  })
})

/** ロードマップ型の単位の名前と副題を、投入データの組み立て（`python3 scripts/build_target_dataset.py --data data/<学び>`）から
 *  論点の並び（UC-002 の listTopics ＝ GET /api/topics）と論点の教材（getTopicDetail ＝ GET /api/topics/{id}）の応答まで、
 *  分けたまま運ぶこと。UC-009
 *
 *  学びの置き場は日で束ねる学び（itc）の写しを一時の作業場に置く。実データの名前や順番には頼らず、仕込みは作業場の写しの上で作る:
 *  全単位の副題を外し、括弧書きを含まない名前の単位を 3 つ選んで、1 つ目にだけ副題を書き足し、2 つ目は名前を括弧書きを含む名前に
 *  書き換え（写しの中の JSON で、その名前と等しい文字列と鍵をすべて同じ名前に置き換える）、3 つ目はそのままにする。
 *  組み立ては作業場を cwd にしてコマンドとして呼び、
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

/** 書き足す副題。 */
const SUBTITLE = '経営の課題を IT で解く役割'
/** 括弧書きを含む名前にするときに名前の後ろに足す括弧書き。 */
const PAREN = '（括弧書きの補足）'
const HAS_PAREN = /[（(].+[）)]/

/** 仕込みで選んだ単位の学ぶ順。副題を書き足す単位と、副題を持たない単位（括弧書きを含む名前に書き換えた単位と、含まない単位）。 */
const pick = { withSubtitle: 0, parenName: 0, plainName: 0 }

let ws: string
/** 学ぶ順の並び（副題を持たない単位の 2 つ）。 */
let plainOrders: number[] = []
let roadmapUnits: Json[]
let build: { status: number | null; out: string }
let dataset: Json[] = []
let d1: D1Database | null = null
let seedError = ''

const run = (script: string) => {
  const r = spawnSync('python3', [script, '--data', `data/${LEARNING}`], { cwd: ws, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

/** 写しの中の JSON で、from と等しい文字列と鍵をすべて to に置き換える。 */
function renameEverywhere(dir: string, from: string, to: string) {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v === from ? to : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === from ? to : k, walk(x)]))
    return v
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) renameEverywhere(f, from, to)
    else if (e.name.endsWith('.json')) {
      const body = fs.readFileSync(f, 'utf8')
      if (!body.includes(JSON.stringify(from))) continue
      fs.writeFileSync(f, JSON.stringify(walk(JSON.parse(body)), null, 2))
    }
  }
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
  const plain = (JSON.parse(fs.readFileSync(file, 'utf8')).units as Json[])
    .filter((u) => typeof u.order === 'number' && !HAS_PAREN.test(String(u.term)))
    .sort((a, b) => a.order - b.order)
  if (plain.length < 3) throw new Error('括弧書きを含まない名前の単位が 3 つ無い（仕込みを作れない）')
  pick.withSubtitle = plain[0].order
  pick.parenName = plain[1].order
  pick.plainName = plain[2].order
  plainOrders = [pick.parenName, pick.plainName]
  renameEverywhere(path.join(ws, 'data', LEARNING), String(plain[1].term), `${plain[1].term}${PAREN}`)

  const roadmap = JSON.parse(fs.readFileSync(file, 'utf8'))
  roadmapUnits = roadmap.units
  for (const u of roadmapUnits) delete u.subtitle
  unitOf(pick.withSubtitle).subtitle = SUBTITLE
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
    const u = unitOf(pick.withSubtitle)
    const t = datasetOf(u.term)
    expect(t.subtitle, '副題が元の文字のまま入っていない').toBe(SUBTITLE)
    expect(String(t.term), '名前に副題が混ざっている').not.toContain(SUBTITLE)
  })

  // @covers REQ-414#no-subtitle-none
  it('副題を持たない単位は、投入データで副題を持たず、名前も元の文字のまま入る（括弧書きを含む名前も切り出さない）', () => {
    expectBuilt()
    expect(unitOf(pick.parenName).term, '仕込み: 括弧書きを含む名前に書き換えられていない').toMatch(HAS_PAREN)
    expect(unitOf(pick.plainName).term, '仕込み: 括弧書きを含まない名前の単位でない').not.toMatch(HAS_PAREN)
    for (const order of plainOrders) {
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
    const u = unitOf(pick.withSubtitle)
    const t = await listed(u.term)
    expect(t).toHaveProperty('subtitle', SUBTITLE)
  })

  // @covers REQ-413#list-no-subtitle-null
  it('論点の並びで、副題が投入されていない単位は subtitle が null で、term は名前のまま返る', async () => {
    for (const order of plainOrders) {
      const t = await listed(unitOf(order).term)
      expect(t, `学ぶ順 ${order}: 副題が無いことが subtitle: null として返っていない`).toHaveProperty('subtitle', null)
    }
  })

  // @covers REQ-413#detail-name-and-subtitle-apart
  it('論点の教材で、副題が投入された論点は term が名前だけ、subtitle がその副題として返る', async () => {
    const u = unitOf(pick.withSubtitle)
    const id = (await listed(u.term)).id
    const body = await get(`/api/topics/${id}`)
    expect(body.topic.term, '名前が名前だけになっていない').toBe(u.term)
    expect(body.topic).toHaveProperty('subtitle', SUBTITLE)
  })

  // @covers REQ-413#detail-no-subtitle-null
  it('論点の教材で、副題が投入されていない論点は subtitle が null で、term は名前のまま返る', async () => {
    for (const order of plainOrders) {
      const u = unitOf(order)
      const id = (await listed(u.term)).id
      const body = await get(`/api/topics/${id}`)
      expect(body.topic.term).toBe(u.term)
      expect(body.topic, `学ぶ順 ${order}: 副題が無いことが subtitle: null として返っていない`).toHaveProperty('subtitle', null)
    }
  })
})

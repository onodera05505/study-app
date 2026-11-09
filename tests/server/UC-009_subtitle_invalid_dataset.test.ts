/** ロードマップ型の投入データの組み立て（`python3 scripts/build_target_dataset.py --data data/<学び>`）が、
 *  ロードマップのデータ（roadmap.json の units）の副題の欄に不正な値を持つ単位を見つけたら、投入データを書き出さずに止まり、
 *  その単位の名前を示すこと。UC-009
 *
 *  学びの置き場は日で束ねる学び（itc）の写しを一時の作業場に置き、ケースごとに全単位の副題の欄を外してから
 *  1 単位（学ぶ順 1 番）の副題の欄にだけ値を入れる。組み立ては作業場を cwd にしてコマンドとして呼び、
 *  観測するのは終了コード、組み立ての出力（標準出力と標準エラー）、作業場の投入データ（data/itc/topics.json）が
 *  組み立ての前から書き換わったかどうか（中身と更新時刻）だけ。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILD = path.join(ROOT, 'scripts', 'build_target_dataset.py')
const LEARNING = 'itc'
/** 副題の欄に値を入れる単位の学ぶ順。 */
const TARGET_ORDER = 1

type Json = Record<string, any>

let ws: string
let roadmapFile: string
let datasetFile: string
let original: Json

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(tmpdir(), 'uc009-subtitle-invalid-'))
  fs.cpSync(path.join(ROOT, 'data', LEARNING), path.join(ws, 'data', LEARNING), { recursive: true })
  // 教材の図は作業場の public の下から読まれる（無いと組み立てが止まる）
  const figures = path.join(ROOT, 'public', 'figures', 'materials', LEARNING)
  if (fs.existsSync(figures))
    fs.cpSync(figures, path.join(ws, 'public', 'figures', 'materials', LEARNING), { recursive: true })
  roadmapFile = path.join(ws, 'data', LEARNING, 'roadmap.json')
  datasetFile = path.join(ws, 'data', LEARNING, 'topics.json')
  original = JSON.parse(fs.readFileSync(roadmapFile, 'utf8'))
})

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
})

/** 学ぶ順 1 番の単位の副題の欄に value を入れたロードマップのデータで組み立て、観測できるものを返す。 */
const buildWith = (value: unknown) => {
  const roadmap = structuredClone(original)
  for (const u of roadmap.units as Json[]) delete u.subtitle
  const target = (roadmap.units as Json[]).find((u) => u.order === TARGET_ORDER)
  if (!target) throw new Error(`ロードマップのデータに学ぶ順 ${TARGET_ORDER} の単位が無い（この検査は空振りになる）`)
  target.subtitle = value
  fs.writeFileSync(roadmapFile, JSON.stringify(roadmap, null, 2))
  // 投入データの組み立て前の姿（中身と更新時刻）。時刻の刻みで同じ値にならないよう、過去の時刻に置き直す
  const past = new Date(Date.now() - 60_000)
  if (fs.existsSync(datasetFile)) fs.utimesSync(datasetFile, past, past)
  const before = fs.existsSync(datasetFile)
    ? { body: fs.readFileSync(datasetFile, 'utf8'), mtime: fs.statSync(datasetFile).mtimeMs }
    : null
  const r = spawnSync('python3', [BUILD, '--data', `data/${LEARNING}`], { cwd: ws, encoding: 'utf8' })
  const after = fs.existsSync(datasetFile)
    ? { body: fs.readFileSync(datasetFile, 'utf8'), mtime: fs.statSync(datasetFile).mtimeMs }
    : null
  return { term: String(target.term), status: r.status, out: `${r.stdout}\n${r.stderr}`, before, after }
}

/** 止まったこと・書き出していないこと・その単位の名前を示したことを確かめる。 */
const expectStopped = (r: ReturnType<typeof buildWith>, label: string) => {
  expect(r.status, `${label}: 組み立てが止まらない（終了 0）:\n${r.out}`).not.toBe(0)
  expect(r.after, `${label}: 投入データが書き出されている`).toEqual(r.before)
  expect(r.out, `${label}: その単位の名前「${r.term}」を示していない:\n${r.out}`).toContain(r.term)
}

describe('副題の欄の不正な値で組み立てを止める（UC-009）', () => {
  // @covers REQ-422#empty-string-stops
  it('副題の欄が空の文字列の単位があると、投入データを書き出さずに止まり、その単位の名前を示す', () => {
    expectStopped(buildWith(''), '空の文字列')
  })

  // @covers REQ-422#blank-only-stops
  it('副題の欄が空白だけの文字列の単位があると、投入データを書き出さずに止まり、その単位の名前を示す', () => {
    const cases: Array<[string, string]> = [
      ['半角の空白', ' '],
      ['全角の空白', '　'],
      ['空白とタブと改行の混ざり', ' \t\n　'],
    ]
    for (const [label, value] of cases) expectStopped(buildWith(value), label)
  })

  // @covers REQ-422#non-string-stops
  it('副題の欄が文字列でも null でもない値の単位があると、投入データを書き出さずに止まり、その単位の名前を示す', () => {
    const cases: Array<[string, unknown]> = [
      ['数の 0', 0],
      ['数の 1', 1],
      ['真偽の false', false],
      ['真偽の true', true],
      ['文字列の配列', ['経営の課題を IT で解く役割']],
      ['入れ物', { text: '経営の課題を IT で解く役割' }],
    ]
    for (const [label, value] of cases) expectStopped(buildWith(value), label)
  })

  // @covers REQ-422#null-or-text-not-stopped
  it('副題の欄が null、または前後に空白があっても中に文字のある文字列の単位だけなら、組み立ては止まらない', () => {
    const cases: Array<[string, unknown]> = [
      ['null', null],
      ['前後に空白があり中に文字のある文字列', '　経営の課題を IT で解く役割 '],
    ]
    for (const [label, value] of cases) {
      const r = buildWith(value)
      expect(r.status, `${label}: 組み立てが止まった:\n${r.out}`).toBe(0)
    }
  })
})

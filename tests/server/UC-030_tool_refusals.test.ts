/** ロードマップのデータを組み立て直す入口（buildRoadmap ＝ `python3 scripts/build_roadmap.py --data <学びの置き場> [--out <置き場>]`）と、
 *  投入データを組み立てる入口（buildTargetDataset ＝ `python3 scripts/build_target_dataset.py --data <学びの置き場>`）が、
 *  組み立てに要る物が無いときに断る形。UC-030
 *
 *  仕込みは足場（UC-030_roadmap_fixture.ts）の一時の作業場に置く。日で束ねる学びとして itc を登録簿から借りる。
 *  登録簿に無い学びの鍵は zzz（登録簿 src/shared/targets.json に無いことを先に確かめる）。
 *  断ったことは、終了コード 1・標準出力の最後の行の ToolError の code・例外の跡（Traceback）が無いこと・作業場の全ファイルが
 *  呼ぶ前のままであること（書き出しも書き換えも無い）で見る。 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Json,
  BUILD_DATASET,
  BUILD_ROADMAP,
  ID,
  ROOT,
  type Run,
  buildDataset,
  cleanup,
  datasetWorkspace,
  dayCandidates,
  roadmapConfig,
  run,
  snapshot,
  workspace,
  writeJson,
} from './UC-030_roadmap_fixture'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

afterEach(cleanup)

const UNKNOWN = 'zzz'

/** 標準出力（全体か最後の空でない行）の ToolError の error。 */
function refusalOf(stdout: string): Json | undefined {
  const read = (text: string) => {
    try {
      const v = JSON.parse(text) as Json
      return v && typeof v.error === 'object' ? (v.error as Json) : undefined
    } catch {
      return undefined
    }
  }
  return read(stdout.trim()) ?? read(stdout.split('\n').filter((l) => l.trim() !== '').pop() ?? '')
}

/** 断った形: 終了 1・ToolError の code・理由が空でない・例外の跡が無い。 */
function expectRefused(r: Run, code: string, where: string) {
  expect(r.status, `${where}: 終了 1 で断らない:\n${r.out}`).toBe(1)
  const e = refusalOf(r.stdout)
  expect(e?.code, `${where}: 標準出力の ToolError の code が ${code} でない:\n${r.out}`).toBe(code)
  expect(String(e?.reason ?? '').length, `${where}: 理由が無い`).toBeGreaterThan(0)
  expect(r.out, `${where}: 例外の跡を残した`).not.toContain('Traceback')
}

/** 作業場の全ファイルの状態を見ながら呼ぶ。 */
function watched(ws: string, call: () => Run): Run & { before: Record<string, string>; after: Record<string, string> } {
  const before = snapshot(ws)
  const r = call()
  return { ...r, before, after: snapshot(ws) }
}

describe('UC-030 論点の候補が無ければ組み立て直さずに断る（REQ-581）', () => {
  // @covers REQ-581#candidates-file-missing
  it('学びの置き場とロードマップの設定はあるが論点の候補のファイルが無ければ、NOT_FOUND で断り、置き場を書き換えない（場合ごと）', () => {
    for (const [label, previous] of [
      ['前のロードマップのデータが無い', null],
      ['前のロードマップのデータがある', { units: [{ topic_id: ID(1), term: '前の単位', order: 1 }] }],
    ] as const) {
      const ws = workspace('uc030-candidates-missing')
      const dir = path.join(ws, 'data', 'itc')
      writeJson(path.join(dir, 'roadmap_config.json'), roadmapConfig())
      if (previous) writeJson(path.join(dir, 'roadmap.json'), previous)
      const r = watched(ws, () => run(ws, BUILD_ROADMAP, ['--data', 'data/itc']))
      expectRefused(r, 'NOT_FOUND', label)
      expect(r.after, `${label}: 書き出しか書き換えがある`).toEqual(r.before)
    }
  })

  // @covers REQ-581#learning-dir-missing
  it('学びの置き場そのものが無ければ、NOT_FOUND で断り、置き場を作らず何も書き出さない', () => {
    const ws = workspace('uc030-place-missing')
    const r = watched(ws, () => run(ws, BUILD_ROADMAP, ['--data', 'data/itc']))
    expectRefused(r, 'NOT_FOUND', '置き場が無い')
    expect(r.after).toEqual(r.before)
    expect(fs.existsSync(path.join(ws, 'data', 'itc')), '置き場を作った').toBe(false)
  })

  // @covers REQ-581#out-given-nothing-written
  it('書き出す置き場を別に指定しても、論点の候補が無ければ NOT_FOUND で断り、その置き場に何も書き出さない', () => {
    const ws = workspace('uc030-candidates-missing-out')
    writeJson(path.join(ws, 'data', 'itc', 'roadmap_config.json'), roadmapConfig())
    const r = watched(ws, () => run(ws, BUILD_ROADMAP, ['--data', 'data/itc', '--out', 'built/itc']))
    expectRefused(r, 'NOT_FOUND', '別の書き出す置き場')
    expect(r.after).toEqual(r.before)
    expect(fs.existsSync(path.join(ws, 'built')), '書き出す置き場を作った').toBe(false)
  })

  // @covers REQ-581#candidates-missing-before-unknown-config-id
  it('論点の候補が無く、ロードマップの設定が論点の ID を指していても、候補が無いことで NOT_FOUND で断り、その ID を示さない', () => {
    const ws = workspace('uc030-candidates-missing-config-id')
    const missingId = ID(97)
    expect(dayCandidates(6).some((c) => c.id === missingId)).toBe(false)
    writeJson(path.join(ws, 'data', 'itc', 'roadmap_config.json'), roadmapConfig({ must_include: [missingId] }))
    const r = watched(ws, () => run(ws, BUILD_ROADMAP, ['--data', 'data/itc']))
    expectRefused(r, 'NOT_FOUND', '候補が無く設定が ID を指す')
    expect(r.after).toEqual(r.before)
    expect(r.stdout, '設定が指す ID を示した').not.toContain(String(missingId))
  })
})

describe('UC-030 登録簿に無い学びかロードマップのデータが無い学びは投入データを組み立てずに断る（REQ-582）', () => {
  /** リポジトリの学び itc を、作業場の data/<name> に写す（教材の図も同じ名前の置き場に）。 */
  function copiedAs(name: string): { ws: string; dir: string } {
    const ws = workspace(`uc030-dataset-${name}`)
    const dir = path.join(ws, 'data', name)
    fs.cpSync(path.join(ROOT, 'data', 'itc'), dir, { recursive: true })
    const figures = path.join(ROOT, 'public', 'figures', 'materials', 'itc')
    if (fs.existsSync(figures)) fs.cpSync(figures, path.join(ws, 'public', 'figures', 'materials', name), { recursive: true })
    return { ws, dir }
  }
  const registryKeys = () =>
    Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Json)

  // @covers REQ-582#unknown-learning-with-roadmap
  it('登録簿に無い学びの置き場に、ロードマップのデータ・教材・確認問題がそろっていても、INVALID_INPUT で断り、何も書き出さない', () => {
    expect(registryKeys()).not.toContain(UNKNOWN)
    // 写しのまま（登録簿にある学びとして）なら組み立てが通ること（仕込みの確かめ）
    const base = buildDataset(datasetWorkspace('itc'))
    expect(base.status, `仕込み: itc の写しのままで組み立てが通らない:\n${base.out}`).toBe(0)
    const { ws, dir } = copiedAs(UNKNOWN)
    expect(fs.existsSync(path.join(dir, 'roadmap.json'))).toBe(true)
    const r = watched(ws, () => run(ws, BUILD_DATASET, ['--data', `data/${UNKNOWN}`]))
    expectRefused(r, 'INVALID_INPUT', '登録簿に無い学び')
    expect(r.after).toEqual(r.before)
  })

  // @covers REQ-582#unknown-learning-before-roadmap-missing
  it('登録簿に無い学びで、置き場にロードマップのデータも無ければ、INVALID_INPUT で断る（場合ごと）', () => {
    for (const label of ['置き場はあるがロードマップのデータが無い', '置き場ごと無い']) {
      const ws = label === '置き場ごと無い' ? workspace('uc030-dataset-unknown-empty') : copiedAs(UNKNOWN).ws
      if (label !== '置き場ごと無い') fs.rmSync(path.join(ws, 'data', UNKNOWN, 'roadmap.json'))
      const r = watched(ws, () => run(ws, BUILD_DATASET, ['--data', `data/${UNKNOWN}`]))
      expectRefused(r, 'INVALID_INPUT', label)
      expect(r.after, `${label}: 書き出しか書き換えがある`).toEqual(r.before)
    }
  })

  // @covers REQ-582#roadmap-missing
  it('登録簿にある学びの置き場に、教材と確認問題はあるがロードマップのデータが無ければ、NOT_FOUND で断り、置き場を書き換えない', () => {
    const d = datasetWorkspace('itc')
    fs.rmSync(d.path('roadmap.json'))
    expect(fs.existsSync(d.path('materials'))).toBe(true)
    expect(fs.existsSync(d.path('roadmap_questions'))).toBe(true)
    const r = watched(d.ws, () => run(d.ws, BUILD_DATASET, ['--data', d.data]))
    expectRefused(r, 'NOT_FOUND', 'ロードマップのデータが無い')
    expect(r.after).toEqual(r.before)
  })

  // @covers REQ-582#learning-dir-missing
  it('登録簿にある学びの置き場そのものが無ければ、NOT_FOUND で断り、置き場を作らず何も書き出さない', () => {
    const ws = workspace('uc030-dataset-place-missing')
    const r = watched(ws, () => run(ws, BUILD_DATASET, ['--data', 'data/itc']))
    expectRefused(r, 'NOT_FOUND', '置き場が無い')
    expect(r.after).toEqual(r.before)
    expect(fs.existsSync(path.join(ws, 'data', 'itc')), '置き場を作った').toBe(false)
  })
})

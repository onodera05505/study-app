/** UC-027 流す前の投入の検査（checkSeed）が、検査する投入が無いときに断ることを、資格対策の学び（ip）の写しを置いた一時の作業場を
 *  cwd にしたコマンドとして呼んで見る。
 *
 *  入口は契約の先頭のコメントの決まり（request の欄は同じ名前の引数）から `python3 scripts/check_seed.py --data <置き場> [--sql <投入>]`。
 *  断ったときは終了コードが 0 でなく、標準出力（全体が 1 つ、または最後の行）に契約の ToolError を出す。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ROOT, cleanWorkspaces, makeWorkspace, type Json, type Ws } from './UC-027_fixture'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

type Out = { status: number | null; stdout: string; out: string }

const checkSeed = (ws: Ws, extra: string[] = []): Out => {
  const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'check_seed.py'), '--data', ws.data, ...extra], {
    cwd: ws.dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout}\n${r.stderr}`.split(ws.dir).join('<ws>') }
}

function jsonOf(stdout: string): Json | null {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    /* 最後の行を読む */
  }
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      continue
    }
  }
  return null
}

function expectNotFound(r: Out, label: string) {
  expect(r.status, `${label}: 断らずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  const e = jsonOf(r.stdout)
  expect(e?.error?.code, `${label}: 標準出力の ToolError の code が NOT_FOUND でない:\n${r.out}`).toBe('NOT_FOUND')
  expect(String(e?.error?.reason ?? '').length, `${label}: 理由が無い`).toBeGreaterThan(0)
}

/** 作業場の data の下のファイルの一覧（相対パス・大きさ・更新時刻）。何も書き出していないことを見る。 */
function treeOf(ws: Ws): string[] {
  const out: string[] = []
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return
    for (const n of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, n.name)
      if (n.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        out.push(`${path.relative(ws.dir, p)}:${st.size}:${st.mtimeMs}`)
      }
    }
  }
  walk(ws.abs('data'))
  return out.sort()
}

afterAll(() => cleanWorkspaces())

describe('検査する投入が無ければ、流す前の投入の検査は中身を見ずに断る（UC-027）', () => {
  let ws: Ws
  beforeAll(() => {
    ws = makeWorkspace('ip')
    ws.remove(`${ws.data}/seed.sql`)
  })

  // @covers REQ-565#given-seed-missing
  it('登録簿にある学びで、渡した投入のファイルが無いと NOT_FOUND で断り、学びの置き場に何も書き出さない', () => {
    const before = treeOf(ws)
    expectNotFound(checkSeed(ws, ['--sql', `${ws.data}/no_such_seed.sql`]), '渡した投入が無い')
    expect(treeOf(ws), '学びの置き場が書き換わった').toEqual(before)
  })

  // @covers REQ-565#default-seed-missing
  it('登録簿にある学びで、投入を渡さず学びの置き場に投入が無いと NOT_FOUND で断り、学びの置き場に何も書き出さない', () => {
    expect(fs.existsSync(ws.abs(`${ws.data}/seed.sql`)), '仕込み: 学びの置き場に投入が残っている').toBe(false)
    const before = treeOf(ws)
    expectNotFound(checkSeed(ws), '学びの置き場に投入が無い')
    expect(treeOf(ws), '学びの置き場が書き換わった').toEqual(before)
  })
})

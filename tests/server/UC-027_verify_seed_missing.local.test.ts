/** UC-027 流したあとの突き合わせ（verifySeedRemote ＝ `python3 scripts/verify_seed_remote.py --data <置き場> --exam <学び> --local [--sql <投入>]`）が、
 *  突き合わせる投入が無いときに DB を見ずに断ることを、資格対策の学び（ip）の写しを置いた一時の作業場を cwd にしたコマンドとして呼んで見る。
 *
 *  DB を見ないことは、配備の道具（npx・wrangler）を、呼ばれたことを記録して何も返さずに失敗する偽物に差し替え、記録が空であることで見る。
 *  どの場合も手元の DB を見る指定（--local）で回し、本番の保存先に届く経路を作らない。
 *  断ったときは終了コードが 0 でなく、標準出力（全体が 1 つ、または最後の行）に契約の ToolError を出す。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ROOT, cleanWorkspaces, makeWorkspace, type Json, type Ws } from './UC-027_fixture.local'

vi.setConfig({ testTimeout: 120_000 })

type Out = { status: number | null; stdout: string; out: string; called: string[] }

/** 呼ばれたことを記録して失敗する偽の配備の道具。 */
const RECORDER = `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$UC027_CALLS"
echo "テストの囲い: 配備の道具は呼ばれない前提" >&2
exit 1
`

function verifySeed(ws: Ws, exam: string, extra: string[] = []): Out {
  const bin = ws.abs('fakebin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['npx', 'wrangler']) fs.writeFileSync(path.join(bin, name), RECORDER, { mode: 0o755 })
  const calls = ws.abs('calls.log')
  fs.writeFileSync(calls, '')
  const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'verify_seed_remote.py'), '--data', ws.data, '--exam', exam, '--local', ...extra], {
    cwd: ws.dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, UC027_CALLS: calls },
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    out: `${r.stdout}\n${r.stderr}`.split(ws.dir).join('<ws>'),
    called: fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.trim() !== ''),
  }
}

function jsonOf(stdout: string): Json | null {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    /* 最後の行を読む */
  }
  const last = stdout.split('\n').filter((l) => l.trim() !== '').pop()
  try {
    return last ? JSON.parse(last) : null
  } catch {
    return null
  }
}

/** 断った形: 終了 0 でない・ToolError の code・理由が空でない・配備の道具を呼んでいない。 */
function expectRefusedWithoutDb(r: Out, code: string, label: string) {
  expect(r.status, `${label}: 断らずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  const e = jsonOf(r.stdout)
  expect(e?.error?.code, `${label}: 標準出力の ToolError の code が ${code} でない:\n${r.out}`).toBe(code)
  expect(String(e?.error?.reason ?? '').length, `${label}: 理由が無い`).toBeGreaterThan(0)
  expect(r.called, `${label}: DB を見に配備の道具を呼んだ`).toEqual([])
}

afterAll(() => cleanWorkspaces())

describe('突き合わせる投入が無ければ、流したあとの突き合わせは DB を見ずに断る（UC-027）', () => {
  // @covers REQ-583#given-seed-missing
  it('登録簿にある学びで、渡した投入のファイルが無いと NOT_FOUND で断り、DB を見ない', () => {
    const ws = makeWorkspace('ip')
    const missing = `${ws.data}/no_such_seed.sql`
    expect(fs.existsSync(ws.abs(missing))).toBe(false)
    expectRefusedWithoutDb(verifySeed(ws, 'ip', ['--sql', missing]), 'NOT_FOUND', '渡した投入が無い')
  })

  // @covers REQ-583#default-seed-missing
  it('登録簿にある学びで、投入を渡さず学びの置き場にも投入が無いと NOT_FOUND で断り、DB を見ない', () => {
    const ws = makeWorkspace('ip')
    ws.remove(`${ws.data}/seed.sql`)
    expectRefusedWithoutDb(verifySeed(ws, 'ip'), 'NOT_FOUND', '置き場の投入が無い')
  })

  // @covers REQ-583#given-seed-is-directory
  it('登録簿にある学びで、渡した投入のパスがディレクトリだと NOT_FOUND で断り、DB を見ない', () => {
    const ws = makeWorkspace('ip')
    const dir = `${ws.data}/seed_dir.sql`
    fs.mkdirSync(ws.abs(dir), { recursive: true })
    expectRefusedWithoutDb(verifySeed(ws, 'ip', ['--sql', dir]), 'NOT_FOUND', '渡した投入がディレクトリ')
  })

  // @covers REQ-583#default-seed-is-directory
  it('登録簿にある学びで、投入を渡さず学びの置き場の投入の位置がディレクトリだと NOT_FOUND で断り、DB を見ない', () => {
    const ws = makeWorkspace('ip')
    ws.remove(`${ws.data}/seed.sql`)
    fs.mkdirSync(ws.abs(`${ws.data}/seed.sql`), { recursive: true })
    expectRefusedWithoutDb(verifySeed(ws, 'ip'), 'NOT_FOUND', '置き場の投入の位置がディレクトリ')
  })

  // @covers REQ-583#unknown-learning-before-seed-missing
  it('登録簿に無い学びで、突き合わせる投入も無いと INVALID_INPUT で断り、DB を見ない', () => {
    const ws = makeWorkspace('ip', 'zzz')
    ws.remove(`${ws.data}/seed.sql`)
    expectRefusedWithoutDb(verifySeed(ws, 'zzz'), 'INVALID_INPUT', '登録簿に無い学びで投入も無い')
  })
})

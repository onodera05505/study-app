import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { callOperation, type PyResult } from '../../scripts/contract_adapter/kit/py'

/**
 * UC-033 の REQ-579: 作り手と運用者の道具が置き場のファイルを読み書きする操作は、呼ばれて契約の errors に当たるとき、
 * 呼んだ側に断りの種類の名前を持つ失敗を渡す。
 *
 * 入口は CLAUDE.md の「操作 → 入口」の「道具の中の読み書き」の行（ADR-0013）: `@operation UC-nnn#操作名` を直上に持つ
 * `scripts/` の Python の関数（名前は操作名の snake_case）を、契約の request の項目をキーワード引数にして呼ぶ。
 * 呼ぶのは契約の実例を渡す受け渡し役と同じ橋（scripts/contract_adapter/kit/py.ts の callOperation）で、
 * 投げられた値の `code` を名前として受け取る。理由の文言は照らさない。
 *
 * 前提のファイルは一時の作業場に置き、作業場を作業ディレクトリにして呼ぶ（契約のパスは相対なら作業ディレクトリが起点）。
 * 操作の選び方: 読む側は単元の構成の門（UC-024）と様式の門（UC-025）の読む操作のすべて。書く側は条件ごとに 1 つ
 * （書き出せない: UC-026 writeUnitInput、既にある: UC-019 writeCycleResult、描けない: UC-019 writePackFigure）。
 */

vi.setConfig({ testTimeout: 30_000 })

const temps: string[] = []
/** 一時の作業場（files は作業場からの相対パス → 中身）。返すのは作業ディレクトリ。 */
function workspace(files: Record<string, string> = {}): string {
  const base = mkdtempSync(join(tmpdir(), 'uc033-io-'))
  temps.push(base)
  const cwd = join(base, 'work')
  mkdirSync(cwd)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true })
    writeFileSync(join(cwd, rel), content)
  }
  return cwd
}

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const call = (uc: string, operation: string, request: Record<string, unknown>, cwd: string) => callOperation(uc, operation, request, { cwd })
/** 名前を持つ失敗を受け取ったこと。 */
const expectCode = (result: PyResult, code: string, label: string) => expect(result, label).toEqual({ code })

/** 読む操作（UC-024・UC-025）と、読むファイルのパス。 */
const READS: [string, string, string][] = [
  ['UC-024', 'readUnitPlan', 'data/ip/unit_plans/21.json'],
  ['UC-024', 'readSyllabusUnits', 'data/ip/syllabus.json'],
  ['UC-024', 'readTopicUnits', 'data/ip/topics.json'],
  ['UC-025', 'readFigureSpec', 'data/ip/material_figures/1.json'],
  ['UC-025', 'readRewrittenMaterialFile', 'data/ip/materials_v4/21-2.json'],
]

const PLAN_21 = {
  unit_no: 21,
  unit: '単元二十一',
  overview: '単元二十一の全体像の文です。',
  groups: [{ name: '土台', description: '土台のまとまりの説明です。', topics: [214, 220, 205, 203] }],
  owners: [],
  prerequisites: { '205': [203] },
}

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  describe('REQ-579 道具の中の読み書きの操作は、契約の errors に当たるとき名前を持つ失敗を渡す', () => {
    // @covers REQ-579#read-missing
    it('読む操作は、読むファイルが無ければ NOT_FOUND の失敗を渡す（操作ごと）', async () => {
      for (const [uc, operation, path] of READS) {
        expectCode(await call(uc, operation, { path }, workspace()), 'NOT_FOUND', `${uc} ${operation}`)
      }
    })

    // @covers REQ-579#read-unreadable
    it('読む操作は、読むファイルが JSON として読めなければ INVALID_INPUT の失敗を渡す（操作ごと）', async () => {
      for (const [uc, operation, path] of READS) {
        expectCode(await call(uc, operation, { path }, workspace({ [path]: '{"途中で": [' })), 'INVALID_INPUT', `${uc} ${operation}`)
      }
    })

    // @covers REQ-579#write-refused
    it('書く操作は、書き出せなければ STORAGE_UNAVAILABLE、既にあれば CONFLICT、描けなければ INTERNAL の失敗を渡す', async () => {
      // 書き出せない: ファイルシステムの根の下の、無く作れない置き場（契約 UC-026 writeUnitInput の unwritable）
      expectCode(
        await call('UC-026', 'writeUnitInput', { path: '/unwritable/21.json', unit_no: 21, unit: 'データベース', field: 'テクノロジ系', major: '技術要素', topics: [] }, workspace()),
        'STORAGE_UNAVAILABLE',
        '書き出せない',
      )
      // 既にある: その周の結果が置き場にある（契約 UC-019 writeCycleResult の exists）
      const result = {
        cycle: 6, score: '0/0', rate: 0, by_goal: {}, by_field: {}, per_unit: {}, reported_units: 0, avg_understood: 0,
        stuck_units: [], overconfident_units: [], unknown_terms: [], shift_suspect: [], shift_window: 3, wrong: [], changed_answers: [],
      }
      expectCode(
        await call('UC-019', 'writeCycleResult', { data: 'data/eng', result }, workspace({ 'data/eng/eval/cycle_6.json': JSON.stringify(result) })),
        'CONFLICT',
        '既にある',
      )
      // 描けない: 図が XML として整わない（契約 UC-019 writePackFigure の notWellFormed）
      const svg = 'public/figures/materials/eng/1-1.svg'
      expectCode(
        await call('UC-019', 'writePackFigure', { out: '../learner_packs/eng_c8', file: svg, target: 'figures/1-1.png', renderTimeoutSeconds: 30 }, workspace({ [svg]: '<svg xmlns="http://www.w3.org/2000/svg"><text>途中' })),
        'INTERNAL',
        '描けない',
      )
    })

    // @covers REQ-579#success-no-failure
    it('errors に当たらない入力では、失敗を渡さず契約の response の形の値を返す（読む操作と書く操作）', async () => {
      const path = 'data/ip/unit_plans/21.json'
      const read = await call('UC-024', 'readUnitPlan', { path }, workspace({ [path]: JSON.stringify(PLAN_21) }))
      expect(read).toEqual({ value: PLAN_21 })

      const cwd = workspace()
      mkdirSync(join(cwd, 'data/ip/unit_inputs'), { recursive: true })
      const written = await call(
        'UC-026',
        'writeUnitInput',
        {
          path: 'data/ip/unit_inputs/21.json',
          unit_no: 21,
          unit: 'データベース',
          field: 'テクノロジ系',
          major: '技術要素',
          topics: [{ topic_id: 214, term: '関係データベース', syllabus_item: 54, syllabus_item_name: 'データベース方式', question_count: 3, related_terms: [], explanation: '**関係データベース**とは、…です。', detail: '### 表と行と列\n…' }],
        },
        cwd,
      )
      expect(written).toEqual({ value: expect.objectContaining({ path: 'data/ip/unit_inputs/21.json' }) })
    })
  })
})

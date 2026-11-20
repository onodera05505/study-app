import { afterAll, describe, expect, it, vi } from 'vitest'
import { FAILURE_TEXT, crashed, removeTemps, shadow, type Shadow, type ToolRun } from './UC-040_fixture'

/** UC-040 フィードバックを取り出して処理の状態を付ける道具（feedback ＝ `python3 scripts/feedback.py <command> [<学び>] [<id> ...]`）の境界。
 *  仕込みは影の根の偽の保存先（UC-040_fixture.ts）。本番の保存先（--remote）と手元の保存先は学びごとに別。
 *  観測するのは終了の状態・出力の文・保存先の行・受け箱のファイル。 */

vi.setConfig({ testTimeout: 120_000 })
afterAll(removeTemps)

/** mkt に未処理 2 件と処理済み 1 件、itc に未処理 1 件、mkt の手元の保存先に未処理 1 件を置いた影の根。 */
function world(): Shadow {
  const s = shadow()
  s.put('mkt', [
    { id: 'fb-mkt-new-1', body: '次へと戻るの場所が分かりにくい' },
    { id: 'fb-mkt-done-1', body: '用語の説明が古かった', status: 'done', note: '直した' },
    { id: 'fb-mkt-new-2', body: '図の文字が小さい' },
  ])
  s.put('itc', [{ id: 'fb-itc-new-1', body: '面接の例がもっと欲しい' }])
  s.put('mkt', [{ id: 'fb-mkt-local-1', body: '手元で試した声' }], 'local')
  return s
}
const expectOk = (r: ToolRun) => {
  expect(crashed(r), r.out).toBe(false)
  expect(r.status, r.out).toBe(0)
}
const inboxText = (s: Shadow, learning: string) => Object.values(s.inbox(learning)).join('\n')

describe('UC-040 届いたフィードバックを取り出し、処理の状態を付ける（feedback）', () => {
  describe('学びを指定して取り出すと、未処理（全部と指定すれば状態を問わない）を示して受け箱に保存する（REQ-625）', () => {
    // @covers REQ-625#new-only
    it('学びを指定すると、本番の未処理だけを示し、受け箱のファイルに保存する', () => {
      const s = world()
      const r = s.run(['fetch', 'mkt'])
      expectOk(r)
      for (const body of ['次へと戻るの場所が分かりにくい', '図の文字が小さい']) expect(r.stdout).toContain(body)
      expect(r.stdout).not.toContain('用語の説明が古かった')
      expect(r.stdout).not.toContain('手元で試した声')
      const inbox = inboxText(s, 'mkt')
      expect(Object.keys(s.inbox('mkt')).length, '受け箱のファイルが無い').toBeGreaterThan(0)
      expect(inbox).toContain('fb-mkt-new-1')
      expect(inbox).toContain('fb-mkt-new-2')
      expect(inbox).not.toContain('fb-mkt-done-1')
    })
    // @covers REQ-625#all-statuses
    it('全部と指定すると、処理済みも示して受け箱に保存する', () => {
      const s = world()
      const r = s.run(['fetch', 'mkt', '--all'])
      expectOk(r)
      for (const body of ['次へと戻るの場所が分かりにくい', '用語の説明が古かった', '図の文字が小さい']) expect(r.stdout).toContain(body)
      expect(inboxText(s, 'mkt')).toContain('fb-mkt-done-1')
    })
    // @covers REQ-625#every-learning
    it('すべての学びと指定すると、学びごとの保存先から取り出し、学びごとの受け箱に保存する', () => {
      const s = world()
      const r = s.run(['fetch', '--every'])
      expectOk(r)
      expect(r.stdout).toContain('次へと戻るの場所が分かりにくい')
      expect(r.stdout).toContain('面接の例がもっと欲しい')
      expect(inboxText(s, 'mkt')).toContain('fb-mkt-new-1')
      expect(inboxText(s, 'itc')).toContain('fb-itc-new-1')
      expect(inboxText(s, 'itc')).not.toContain('fb-mkt-new-1')
    })
    // @covers REQ-625#local-storage
    it('手元と指定すると、本番でなく手元の保存先から取り出す', () => {
      const s = world()
      const r = s.run(['fetch', 'mkt', '--local'])
      expectOk(r)
      expect(r.stdout).toContain('手元で試した声')
      expect(r.stdout).not.toContain('次へと戻るの場所が分かりにくい')
    })
  })

  describe('処理の状態と注記を付けると書き換え、見つからないものがあれば示して失敗で終える（REQ-626）', () => {
    // @covers REQ-626#status-and-note
    it('指定した 1 つの状態と注記を書き換え、指定していないものは変えない', () => {
      const s = world()
      const r = s.run(['mark', 'mkt', 'fb-mkt-new-1', '--status', 'done', '--note', '次へと戻るを大きくした'])
      expectOk(r)
      const rows = Object.fromEntries(s.rows('mkt').map((x) => [x.id, x]))
      expect(rows['fb-mkt-new-1'].status).toBe('done')
      expect(rows['fb-mkt-new-1'].note).toBe('次へと戻るを大きくした')
      expect(rows['fb-mkt-new-2'].status).toBe('new')
      expect(rows['fb-mkt-new-2'].note).toBeNull()
      expect(rows['fb-mkt-done-1'].note).toBe('直した')
    })
    // @covers REQ-626#several-ids
    it('指定した 2 つの状態をどちらも書き換える', () => {
      const s = world()
      const r = s.run(['mark', 'mkt', 'fb-mkt-new-1', 'fb-mkt-new-2', '--status', 'triaged'])
      expectOk(r)
      for (const row of s.rows('mkt').filter((x) => x.id.startsWith('fb-mkt-new'))) expect(row.status, row.id).toBe('triaged')
    })
    // @covers REQ-626#unknown-id
    it('見つからないものを含めて指定すると、それを示して失敗で終え、指定していないものは変えない', () => {
      const s = world()
      const r = s.run(['mark', 'mkt', 'fb-mkt-new-1', 'fb-missing-9', '--status', 'done'])
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('fb-missing-9')
      const rows = Object.fromEntries(s.rows('mkt').map((x) => [x.id, x]))
      expect(rows['fb-mkt-new-2'].status).toBe('new')
      expect(rows['fb-mkt-done-1'].status).toBe('done')
      expect(s.rows('itc')[0].status).toBe('new')
    })
    // @covers REQ-626#local-storage
    it('手元と指定すると、手元の保存先を書き換え、本番は変えない', () => {
      const s = world()
      const r = s.run(['mark', 'mkt', 'fb-mkt-local-1', '--status', 'done', '--note', '手元で直した', '--local'])
      expectOk(r)
      expect(s.rows('mkt', 'local')[0]).toMatchObject({ id: 'fb-mkt-local-1', status: 'done', note: '手元で直した' })
      expect(s.rows('mkt').map((x) => x.status)).toEqual(['done', 'new', 'new'])
    })
  })

  describe('未処理の件数を求めると、学びごとの件数だけを 1 行で示す（REQ-627）', () => {
    // @covers REQ-627#counts-per-learning
    it('学びごとの未処理の件数を 1 行で示し、処理済みは数えない', () => {
      const r = world().run(['summary'])
      expectOk(r)
      const lines = r.stdout.split('\n').filter((l) => l.trim() !== '')
      expect(lines, r.stdout).toHaveLength(1)
      const near = (key: string, n: number) => new RegExp(`${key}\\D{0,4}${n}(?!\\d)|(?<!\\d)${n}\\D{0,6}${key}`).test(lines[0])
      expect(near('mkt', 2), `mkt の 2 件が無い: ${lines[0]}`).toBe(true)
      expect(near('itc', 1), `itc の 1 件が無い: ${lines[0]}`).toBe(true)
    })
    // @covers REQ-627#none
    it('未処理が無いときも 1 行で示して成功で終える', () => {
      const r = shadow().run(['summary'])
      expectOk(r)
      expect(r.stdout.split('\n').filter((l) => l.trim() !== ''), r.stdout).toHaveLength(1)
    })
  })

  describe('保存先への問い合わせが続けて失敗すると、その学びと失敗の出力を示して失敗で終える（REQ-628）', () => {
    const expectFailed = (r: ToolRun) => {
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('mkt')
      expect(r.out).toContain(FAILURE_TEXT)
    }
    // @covers REQ-628#fetch-fails
    it('取り出すときに失敗が続くと、学びと失敗の出力を示して失敗で終える', () => {
      expectFailed(world().run(['fetch', 'mkt'], ['mkt']))
    })
    // @covers REQ-628#mark-fails
    it('状態を付けるときに失敗が続くと、学びと失敗の出力を示して失敗で終え、保存先は変わらない', () => {
      const s = world()
      expectFailed(s.run(['mark', 'mkt', 'fb-mkt-new-1', '--status', 'done'], ['mkt']))
      expect(s.rows('mkt').find((x) => x.id === 'fb-mkt-new-1')?.status).toBe('new')
    })
    // @covers REQ-628#summary-fails
    it('件数を求めるときに失敗が続くと、学びと失敗の出力を示して失敗で終える', () => {
      expectFailed(world().run(['summary'], ['mkt']))
    })
  })
})

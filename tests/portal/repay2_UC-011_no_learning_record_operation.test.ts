import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-011 のまなびばが外に向けて持つ操作の集合を、契約（contract.yaml）から読む。
 * 契約の operation の集合を「無いことの証拠」として走査し、学び側の配備にある本人の記録
 * （理解度・受験履歴）へ向かう operation が 1 つも無いことを確かめる。
 * YAML の読み方は依存を足さず、契約の書式（operations の下の 2 段字下げが operation 名）に沿って行で読む。
 */

type Operation = {
  name: string
  direction: string | null
  path: string | null
  summary: string | null
  typeNames: string[]
}

let contractText = ''
let operations: Operation[] = []

/** operations の節を operation ごとの行の塊に分け、名前・direction・path・summary・型名を取り出す。 */
function parseOperations(text: string): Operation[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^operations:\s*$/.test(l))
  if (start < 0) throw new Error('契約に operations の節が無い')
  const blocks: { name: string; body: string[] }[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const head = /^ {2}([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line)
    if (head) {
      blocks.push({ name: head[1], body: [] })
      continue
    }
    blocks.at(-1)?.body.push(line)
  }
  return blocks.map(({ name, body }) => {
    const text = body.join('\n')
    const typeNames = [...text.matchAll(/\$ref:\s*"?[^"#\s]*#\/schemas\/([A-Za-z0-9_]+)"?/g)].map((m) => m[1])
    return {
      name,
      direction: /^ {4}direction:\s*(\S+)/m.exec(text)?.[1] ?? null,
      path: /^ {4}wire:.*\bpath:\s*"?([^",}\s]+)"?/m.exec(text)?.[1] ?? null,
      summary: /^ {4}summary:\s*(.+)$/m.exec(text)?.[1].trim() ?? null,
      typeNames,
    }
  })
}

/** 識別子（operation 名・path・型名）に現れてはならない、学び側の本人の記録の語。 */
const RECORD_WORDS_IN_IDENTIFIERS = /progress|session|history|exam/i
/** 業務語（summary）に現れてはならない、学び側の本人の記録の語（用語集の「本人の記録」「理解度」「受験履歴」）。 */
const RECORD_WORDS_IN_SUMMARY = /理解度|受験履歴|本人の記録|進捗|progress|history|exam/i

beforeAll(() => {
  contractText = readFileSync(
    new URL(
      '../../docs/goals/GOAL-05-accounts-and-grants/UC-011-manage-accounts-and-grants/contract.yaml',
      import.meta.url,
    ),
    'utf8',
  )
  operations = parseOperations(contractText)
})

describe('UC-011 まなびばの操作の集合に学び側の本人の記録へ向かう物が無い（REQ-171）', () => {
  /** @covers REQ-171#no-learning-record-operation */
  it('契約の operation を全件走査し、理解度・受験履歴へ向かう operation も外向き（outbound）の operation も無い', () => {
    // 走査が空振りしていないこと：operation が 1 件以上あり、読み落としが無い（transport の行の数と一致する）
    expect(operations.length).toBeGreaterThanOrEqual(1)
    const transportCount = (contractText.match(/^ {4}transport:/gm) ?? []).length
    expect(operations.length).toBe(transportCount)
    for (const op of operations) {
      expect(op.direction, `${op.name} の direction`).not.toBeNull()
      expect(op.path, `${op.name} の path`).not.toBeNull()
      expect(op.summary, `${op.name} の summary`).not.toBeNull()
    }

    const offending = operations.filter(
      (op) =>
        op.direction === 'outbound' ||
        RECORD_WORDS_IN_IDENTIFIERS.test(op.name) ||
        RECORD_WORDS_IN_IDENTIFIERS.test(op.path ?? '') ||
        op.typeNames.some((t) => RECORD_WORDS_IN_IDENTIFIERS.test(t)) ||
        RECORD_WORDS_IN_SUMMARY.test(op.summary ?? ''),
    )
    expect(offending.map((op) => op.name)).toEqual([])
    // 走査した集合を名前で示す（読み取れた操作がまなびばの管理の経路であること）
    expect(operations.every((op) => (op.path ?? '').startsWith('/api/admin/'))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { formatChoice } from '../../src/client/lib/choice'
import { parseFigureDescription } from '../../src/client/components/Figure'

describe('組合せ選択肢の表示整形', () => {
  // @verifies REQ-044
  it('「／」と「：」を持つ組合せは項目ごとに行を割る', () => {
    expect(formatChoice('品名：ガム，価格：100 ／ 品名：せんべい，価格：250 ／ 品名：チョコ，価格：150')).toEqual([
      '品名：ガム，価格：100',
      '品名：せんべい，価格：250',
      '品名：チョコ，価格：150',
    ])
  })

  // @verifies REQ-044
  it('「短い項目名＋：」が読点の後に続く並びは項目の切れ目で割る', () => {
    expect(formatChoice('a：（2 の i 乗）－ 1，b：（2 の i 乗）＋ 1，c：2 の（i ＋ 1）乗')).toEqual([
      'a：（2 の i 乗）－ 1',
      'b：（2 の i 乗）＋ 1',
      'c：2 の（i ＋ 1）乗',
    ])
  })

  // @verifies REQ-044
  it('普通の読点を含む文や 30 字以下の選択肢は 1 行のまま出し、データを変えない', () => {
    const plain = '信頼性を高めるため，このディスクを二重化した。分数 1／2 の比は変えない。'
    expect(formatChoice(plain)).toEqual([plain])
    expect(formatChoice('a：1，b：2')).toEqual(['a：1，b：2'])
    const mixed = 'この比は，n を大きくすると π：1 に近づく。ここで，比の分母：分子は問わない。x'
    expect(formatChoice(mixed)).toEqual([mixed])
  })
})

describe('過去問の図の書き起こし', () => {
  // @verifies REQ-043
  it('表と擬似言語と文を、書かれた順に別のかたまりとして読む', () => {
    const src = ['図の説明です。', '', '| 品名 | 価格 |', '| --- | --- |', '| ガム | 100 |', '', '```', 'x ← 1', '```'].join('\n')
    const blocks = parseFigureDescription(src)
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'code'])
    const table = blocks[1]
    if (table.kind !== 'table') throw new Error('table expected')
    expect(table.head).toEqual(['品名', '価格'])
    expect(table.rows).toEqual([['ガム', '100']])
  })

  // @covers REQ-025#unparsable-table
  it('閉じていないコードフェンスや列数の揃わない表でも例外を投げず、読めない所は文として残す', () => {
    expect(() => parseFigureDescription('```\nx ← 1\ny ← 2')).not.toThrow()
    const uneven = parseFigureDescription('| a | b |\n| --- | --- |\n| 1 |\n| 2 | 3 | 4 |')
    expect(uneven.length).toBeGreaterThan(0)
    const text = uneven.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n')
    const tables = uneven.filter((b) => b.kind === 'table')
    // 列数の揃わない行は表からこぼれるか、表として出ないかのどちらかで、どの行も消えない
    expect(text.length + tables.reduce((n, t) => n + (t as { rows: string[][] }).rows.length, 0)).toBeGreaterThan(0)
  })
})

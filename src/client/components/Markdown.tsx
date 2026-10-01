import { Fragment, useState, type ReactNode } from 'react'
import { TermPop } from './TermPop'

/** 教材（解説・周辺知識）を描画する。
 *
 *  扱うのは Markdown の**ごく一部**だけで、汎用のパーサではない。
 *  対応するのは次の6つ。
 *
 *  - 見出し `### `
 *  - 箇条書き `- `
 *  - 番号付き `1. `
 *  - 強調 `**…**`
 *  - 用語のポップ `[[用語]]`（押すと1行の説明が出る。ページは移らない）
 *  - 表（GitHub 風のパイプ表。3つ以上の用語を2〜4の観点で見比べるときに使う）
 *  - 図の画像行（行全体が `![キャプション](/figures/materials/…)` のときだけ）
 *
 *  リンク・任意の URL の画像・コードブロック・引用は意図的に外してある。書き手が
 *  複数いるので、記法を絞らないと担当ごとに見た目がばらつく
 *  （`scripts/prompts/write_materials.md` で書ける記法を固定し、
 *  `scripts/check_materials.py` で機械的に弾いている）。
 *
 *  画像は書き手が入れるものではない。論点ごとの図はスクリプトが
 *  `public/figures/materials/<試験>/<論点ID>-<n>.svg` に生成し、教材テキストへ
 *  画像行として差し込む。だから src は `/figures/materials/` で始まるものだけ通し、
 *  外部 URL は画像にせず、ただの段落として出す。
 *
 *  記法を使っていない古い教材（プレーンテキストで改行区切り）もそのまま通る。
 *  1行 = 1段落として描画されるので、書き直し前後が混在していても崩れない。
 *
 *  dangerouslySetInnerHTML は使わない。教材は自分たちで書いたものだが、
 *  DB 経由で来る文字列を HTML として流し込む口を作らないでおく。 */

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; head: string[] | null; rows: string[][] }
  | { kind: 'image'; src: string; caption: string }

const HEADING = /^###\s+(.*\S)\s*$/
const BULLET = /^[-*]\s+(.*\S)\s*$/
const NUMBER = /^\d+[.)]\s+(.*\S)\s*$/
/** 行全体が画像1つ。前後に文字があるものは画像として扱わない。 */
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/
/** 通してよい画像の置き場所。ここだけ。 */
const FIGURE_PREFIX = '/figures/materials/'
/** 区切り行のセル（`---` / `:---` / `---:`）。 */
const DELIM_CELL = /^:?-+:?$/

/** 表の1行をセルに割る。行頭・行末のパイプは省略されていてもよい。
 *  セル内のパイプのエスケープ（`\|`）は扱わない（書ける記法から外してある）。 */
function cells(line: string): string[] {
  let s = line
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 表の行に見えるか。パイプで2つ以上に割れることが条件。
 *  パイプを含んだ箇条書きを表と取り違えないよう、`|` で始まらない行は
 *  リストの項目でないことも条件にする。 */
function isRow(line: string): boolean {
  if (!line.includes('|')) return false
  if (!line.startsWith('|') && (BULLET.test(line) || NUMBER.test(line))) return false
  return cells(line).length >= 2
}

function isDelimiter(row: string[]): boolean {
  return row.length >= 2 && row.every((c) => DELIM_CELL.test(c))
}

// @implements REQ-003, BR-025
function parse(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] })
      continue
    }

    // 図の画像行。置き場所が違うものは画像にせず、そのまま段落として出す。
    // @implements REQ-004
    const image = IMAGE.exec(line)
    if (image && image[2].startsWith(FIGURE_PREFIX)) {
      blocks.push({ kind: 'image', src: image[2], caption: image[1] })
      continue
    }

    // 表。連続する行をまとめて1つの表にする。2行目が区切り行なら1行目がヘッダ。
    if (isRow(line)) {
      const rows: string[][] = []
      let j = i
      while (j < lines.length && isRow(lines[j].trim())) {
        rows.push(cells(lines[j].trim()))
        j++
      }
      // 1行だけのものは表と見なさない（パイプを含んだ文章の巻き込みを防ぐ）
      if (rows.length >= 2) {
        const head = isDelimiter(rows[1]) ? rows[0] : null
        const body = head ? rows.slice(2) : rows
        blocks.push({ kind: 'table', head, rows: body })
        i = j - 1
        continue
      }
    }

    const bullet = BULLET.exec(line)
    const number = bullet ? null : NUMBER.exec(line)
    if (bullet || number) {
      const kind = bullet ? 'ul' : 'ol'
      const item = (bullet ?? number)![1]
      const last = blocks[blocks.length - 1]
      // 連続する項目は1つのリストにまとめる。間に段落が挟まれば別のリストになる。
      if (last && last.kind === kind) last.items.push(item)
      else blocks.push({ kind, items: [item] } as Block)
      continue
    }

    blocks.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

/** 行の中の記法。`**…**` は <b>、`[[…]]` は押せる用語にする。
 *  閉じていない `**` や `[[` はそのまま文字として残す（本文が消えないほうが大事）。 */
const INLINE = /\*\*(.+?)\*\*|\[\[([^\[\]\n]+)\]\]/g

// @implements REQ-007
function inline(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  // 使い回すと lastIndex が残るので、呼ぶたびに 0 に戻す
  INLINE.lastIndex = 0
  let mo: RegExpExecArray | null
  while ((mo = INLINE.exec(text)) !== null) {
    if (mo.index > last) {
      out.push(<Fragment key={out.length}>{text.slice(last, mo.index)}</Fragment>)
    }
    // 太字の中にも `[[用語]]` が来る（教材の「関連用語」（資格版は「混同しやすい用語」）は `- **[[用語]]** — 説明` の形）。
    // 中身をもう一度この関数に通さないと、太字の中では [[…]] が文字のまま出てしまう。
    // INLINE は共有の正規表現なので、再帰から戻ったあとに lastIndex を戻す。
    if (mo[1] !== undefined) {
      const resume = INLINE.lastIndex
      const innerText = mo[1]
      const inner = inline(innerText)
      INLINE.lastIndex = resume
      out.push(<b key={out.length}>{inner}</b>)
    } else out.push(<TermPop key={out.length} term={mo[2]} />)
    last = mo.index + mo[0].length
  }
  if (last < text.length) out.push(<Fragment key={out.length}>{text.slice(last)}</Fragment>)
  return out
}

/** 段落を作らずに行の中の記法だけを描く。問題の解説の1行に使う。 */
// @implements-old REQ-139
export function Inline({ text }: { text: string }) {
  return <>{inline(text)}</>
}

/** 表。狭い画面でページ全体が横に伸びないよう、表だけ横スクロールさせる。 */
function Table({ head, rows }: { head: string[] | null; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table className="md-table">
        {head && (
          <thead>
            <tr>
              {/* 行見出しの列があると左上のセルが空になる。空の <th> は
                  「名前の無い見出し」として読み上げられるので（axe の
                  empty-table-header）、見出しではない印として td で出す。 */}
              {head.map((c, i) =>
                c ? (
                  <th key={i}>{inline(c)}</th>
                ) : (
                  <td key={i} aria-hidden="true" />
                ),
              )}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j}>{inline(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 教材の図。過去問の図（Figure.tsx）と同じくタップで原寸に切り替える。
 *
 *  スマホでは幅に合わせて縮むと文字が読めなくなる図がある。過去問側にだけ
 *  拡大があって教材側に無いのは、同じ絵なのに扱いが違って見える。 */
// @implements REQ-006
function MdFigure({ src, caption }: { src: string; caption: string }) {
  const [zoomed, setZoomed] = useState(false)
  return (
    <figure className={`md-figure ${zoomed ? 'zoomed' : ''}`}>
      <button
        type="button"
        className="figure-zoom"
        onClick={() => setZoomed((v) => !v)}
        aria-label={zoomed ? '図を画面幅に合わせる' : '図を原寸で表示する'}
      >
        {/* 教材の図は本文を読む助けなので、画面に来てから読み込めばよい */}
        <img src={src} alt={caption} loading="lazy" />
      </button>
      {caption && <figcaption>{caption}</figcaption>}
      <figcaption className="figure-hint">
        {zoomed ? 'タップで画面幅に戻す（横にスクロールできます）' : 'タップで拡大'}
      </figcaption>
    </figure>
  )
}

// @implements-old REQ-018, REQ-017
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parse(source)
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') return <h3 key={i}>{inline(b.text)}</h3>
        if (b.kind === 'paragraph') return <p key={i}>{inline(b.text)}</p>
        if (b.kind === 'table') return <Table key={i} head={b.head} rows={b.rows} />
        if (b.kind === 'image') return <MdFigure key={i} src={b.src} caption={b.caption} />
        const items = b.items.map((item, j) => <li key={j}>{inline(item)}</li>)
        return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>
      })}
    </div>
  )
}

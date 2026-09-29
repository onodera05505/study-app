import { useState } from 'react'

/** 問題に添えられた図表を表示する。
 *
 *  図として描かれているもの（ブロック図・アローダイアグラム・擬似言語など）は
 *  原本から切り出した画像を出す。文章で読むより速く、本番も図で出るため。
 *  表は画像を持たせておらず、Markdown 風の書き起こしを出す。
 *  そちらのほうが折り返しに強く読みやすい。
 *
 *  スマホでは幅に合わせて縮むと図が小さくなりすぎる（660px の図が 300px 程度に
 *  なる）。擬似言語プログラムのように文字が詰まった図は読めないので、
 *  タップで原寸に切り替えて横スクロールで読めるようにしている。 */

/** 書き起こしの中身。説明文・表・コードが混ざる。 */
type FigBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[] | null; rows: string[][] }

/** 区切り行のセル（`---` / `:---` / `---:`）。 */
const DELIM_CELL = /^:?-+:?$/

/** 表の1行をセルに割る。行頭・行末のパイプは省略されていてもよい。 */
function cells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 表の行として拾うのは `|` で始まる行だけ。
 *  文中にパイプを含んだだけの説明文を表に巻き込まないため。 */
function isRow(line: string): boolean {
  return line.trim().startsWith('|')
}

function isDelimiter(row: string[]): boolean {
  return row.length >= 1 && row.every((c) => DELIM_CELL.test(c))
}

function isFence(line: string): boolean {
  return line.trim().startsWith('```')
}

/** 前後の空行を落とす。ブロックの間が間延びしないようにする。 */
function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

/** 図表の書き起こしをブロックに割る。
 *
 *  これは**検証済みでないデータ**を相手にする。教材（`Markdown.tsx`）と違って
 *  書き手が機械（画像の読み取り）なので、閉じていないコードフェンスや列数の
 *  揃っていない表が来うる。どんな入力でも例外を投げず、表と解釈できない
 *  かたまりは素のテキストとして出す。 */
// @implements REQ-012, REQ-043
export function parseFigureDescription(src: string): FigBlock[] {
  const blocks: FigBlock[] = []
  const lines = src.split('\n')
  let text: string[] = []

  const flushText = () => {
    const body = trimBlank(text)
    if (body.length) blocks.push({ kind: 'text', text: body.join('\n') })
    text = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // コードブロック。閉じるフェンスが無い場合は解釈をあきらめ、
    // フェンスの行ごと素のテキストとして出す（残り全部を飲み込ませない）。
    if (isFence(line)) {
      let j = i + 1
      while (j < lines.length && !isFence(lines[j])) j++
      if (j < lines.length) {
        flushText()
        // 擬似言語プログラムは字下げに意味があるので中身は加工しない。
        blocks.push({ kind: 'code', text: trimBlank(lines.slice(i + 1, j)).join('\n') })
        i = j
        continue
      }
      text.push(line)
      continue
    }

    // 表。`|` で始まる行が続くかたまりを1つの表にする。
    // 2行目が区切り行なら1行目がヘッダ。無ければ全行をデータ行にする
    // （区切り行を書かない書き起こしが実際にある）。
    if (isRow(line)) {
      let j = i
      const rows: string[][] = []
      while (j < lines.length && isRow(lines[j])) {
        rows.push(cells(lines[j]))
        j++
      }
      const head = rows.length >= 2 && isDelimiter(rows[1]) ? rows[0] : null
      const body = head ? rows.slice(2) : rows
      const width = Math.max(...rows.map((r) => r.length))
      const filled = rows.some((r) => r.some((c) => c))
      // 中身が空のものは表にしない。`|` だけの行などは素のテキストで出す。
      if (filled && width >= 1 && (head || body.length >= 1)) {
        flushText()
        blocks.push({
          kind: 'table',
          // 列数が揃っていない行は、多いほうに合わせて空セルで埋める。
          head: head ? pad(head, width) : null,
          rows: body.map((r) => pad(r, width)),
        })
        i = j - 1
        continue
      }
      for (let k = i; k < j; k++) text.push(lines[k])
      i = j - 1
      continue
    }

    text.push(line)
  }
  flushText()
  return blocks
}

function pad(row: string[], width: number): string[] {
  return row.length >= width ? row : [...row, ...Array(width - row.length).fill('')]
}

/** 表。狭い画面でページ全体が横に伸びないよう、表だけ横スクロールさせる
 *  （教材の表と同じ扱い）。 */
function FigTable({ head, rows }: { head: string[] | null; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table className="fig-table">
        {head && (
          <thead>
            <tr>
              {/* 行見出しの列がある表は左上のセルが空になる。空の <th> は
                  「名前の無い見出し」として読み上げられるので（axe の
                  empty-table-header）、見出しではない印として td で出す。
                  Markdown.tsx の表と同じ扱い。 */}
              {head.map((c, i) => (c ? <th key={i}>{c}</th> : <td key={i} aria-hidden="true" />))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 書き起こし本文。dangerouslySetInnerHTML は使わない。
 *  DB 経由で来る文字列を HTML として流し込む口を作らないでおく。 */
function Description({ source }: { source: string }) {
  const blocks = parseFigureDescription(source)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'table') return <FigTable key={i} head={b.head} rows={b.rows} />
        if (b.kind === 'code') return <pre key={i} className="fig-code">{b.text}</pre>
        return (
          <div key={i} className="fig-text">
            {b.text}
          </div>
        )
      })}
    </>
  )
}

// @implements REQ-012, REQ-043
export function Figure({
  hasFigure,
  description,
  image,
}: {
  hasFigure: boolean | number
  description: string | null
  image?: string | null
}) {
  const [zoomed, setZoomed] = useState(false)
  // 書き起こしは読み上げ・検索のために持っているもので、図が読める人には
  // 図の丸ごと重複になる。既定では畳んでおき、必要な人だけ開く。
  // 画像が無い問題（表だけの図）は書き起こしが本体なので、そのまま出す。
  const [openDescription, setOpenDescription] = useState(false)

  if (!hasFigure) return null
  return (
    <>
      {image && (
        <figure className={`figure-image ${zoomed ? 'zoomed' : ''}`}>
          <button
            type="button"
            className="figure-zoom"
            onClick={() => setZoomed((v) => !v)}
            aria-label={zoomed ? '図を画面幅に合わせる' : '図を原寸で表示する'}
          >
            {/* 図は問題を解くのに必須なので遅延読み込みしない。
                一瞬でも空欄が出ると、時間制限のある過去問実践で不利になる。 */}
            <img src={image} alt="問題の図" />
          </button>
          <figcaption className="figure-hint">
            {zoomed ? 'タップで画面幅に戻す（横にスクロールできます）' : 'タップで拡大'}
          </figcaption>
        </figure>
      )}
      {description &&
        (image ? (
          <>
            <div className="btn-row">
              <button
                className="btn"
                onClick={() => setOpenDescription((v) => !v)}
                aria-expanded={openDescription}
              >
                {openDescription ? '図の説明を閉じる' : '図の説明（読み上げ・検索用）'}
              </button>
            </div>
            {openDescription && (
              <div className="figure">
                <Description source={description} />
              </div>
            )}
          </>
        ) : (
          <div className="figure">
            <Description source={description} />
          </div>
        ))}
    </>
  )
}

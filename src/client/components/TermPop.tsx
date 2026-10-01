import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useGlossary } from '../lib/glossary'

type Pos = { top: number; left: number }

/** 本文に出す表示名。用語集の見出し語は `ARP（アドレス解決プロトコル）` のように
 *  読み・英字表記の括弧書きを末尾に持つ正式表記になる。文中ではその括弧書きを落として
 *  短くする。末尾に括弧書きが無い語はそのまま。
 *  ポップの見出しには正式表記をそのまま出す。 */
// @implements-old REQ-140
// @implements REQ-008
export function shortTerm(term: string): string {
  const m = term.match(/^(.+?)\s*[（(].*[）)]$/)
  return m ? m[1] : term
}

/** 本文中の `[[用語]]` を、押すと1行の説明が出る文字にする。
 *
 *  **押しても画面は移らない。** 用語が出てくるたびに別ページへ飛ばされると、
 *  読んでいた本文に戻るのが手間で、結局読み通せない。その場で1行だけ見せて、
 *  読み続けられるようにする。ドンピシャの論点があるときだけ、ポップの中に
 *  小さくリンクを置く（**そこを押したときだけ**移動する）。
 *
 *  用語集に無い用語は色を付けず、ただの文字として出す。解説や教材の書き手が
 *  `[[…]]` と書いた用語がまだ用語集に無くても、画面は壊れない。
 *
 *  ポップは body に出す（ポータル）。本文の中に置くと、教材の表
 *  （`.table-wrap` が横スクロールのため overflow を持つ）の中の用語で
 *  カードが切り落とされる。位置はボタンの座標から毎回計算する。 */
// @implements-old REQ-016, REQ-142
// @implements REQ-008, REQ-010, REQ-011
export function TermPop({ term }: { term: string }) {
  const glossary = useGlossary()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  /** ボタンの直下に置く。画面の端からはみ出す場合は内側へ寄せ、
   *  下に入らない場合はボタンの上に出す。 */
  const place = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const b = btn.getBoundingClientRect()
    const card = cardRef.current
    const margin = 8
    const gap = 6
    const w = card?.offsetWidth ?? 0
    const h = card?.offsetHeight ?? 0
    let left = b.left
    if (w) left = Math.max(margin, Math.min(left, window.innerWidth - margin - w))
    let top = b.bottom + gap
    if (h && top + h > window.innerHeight - margin && b.top - gap - h > margin) {
      top = b.top - gap - h
    }
    setPos((prev) =>
      prev && prev.top === top && prev.left === left ? prev : { top, left },
    )
  }, [])

  // 開いた直後に置く。1回目はカードの大きさが分からないので、
  // 描いてからもう一度測って寄せ直す（同じ座標なら再描画されない）。
  useLayoutEffect(() => {
    if (open) place()
  })

  // 外側を触るか Esc で閉じる。スクロール・画面回転では位置を追う。
  // @implements REQ-013
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || cardRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  // 未取得（null）のうちは色を付けない。取れてから色が付く。
  // @implements REQ-005, REQ-009, BR-015
  const entry = glossary?.get(term)
  if (!entry) return <>{term}</>

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="term-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={term}
      >
        {shortTerm(term)}
      </button>
      {open &&
        createPortal(
          <div
            className="term-card"
            ref={cardRef}
            role="dialog"
            aria-label={entry.term}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            <b>{entry.term}</b>
            <span className="term-brief">{entry.brief}</span>
            {entry.topicId !== null && (
              <Link
                className="term-link"
                to={`/topics/${entry.topicId}`}
                onClick={() => setOpen(false)}
              >
                この論点を学ぶ →
              </Link>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

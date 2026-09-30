import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'

export type GlossaryEntry = {
  term: string
  /** 1行の説明。ポップの中身。 */
  brief: string
  /** ドンピシャの論点があればその ID。あればポップに「この論点を学ぶ →」が出る。 */
  topicId: number | null
}

/** 用語集をアプリを開いている間だけ覚えておく。
 *
 *  数百語あるが1語が1行なので、まとめて1回だけ取る。用語ごとに問い合わせると
 *  教材1ページで何十回も往復することになる（1リクエスト 0.2〜0.4 秒）。
 *
 *  **null ＝未取得 / Map ＝取得済み。** 空の Map で初期化しない。未取得と
 *  「用語集が空」を区別できないと、読み込み中に「その用語は無い」と判断して
 *  色を付けそこねる（CLAUDE.md の一覧の落とし穴と同じ理由）。
 *
 *  リロードすれば消える。データを入れ替えたあとは再読み込みで最新になる。 */
let cache: Map<string, GlossaryEntry> | null = null
let inflight = false
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot() {
  return cache
}

/** まだ取っていなければ取りにいく。何度呼んでも1回しか飛ばない。 */
// @implements-old REQ-136, REQ-141
export function ensureGlossary() {
  if (cache || inflight) return
  inflight = true
  api<{ glossary: GlossaryEntry[] }>('/glossary')
    .then((d) => {
      cache = new Map(d.glossary.map((g) => [g.term, g]))
    })
    .catch(() => {
      // 取れなくても本文は読める。用語に色が付かないだけにして、画面は出す。
      cache = new Map()
    })
    .finally(() => {
      inflight = false
      emit()
    })
}

/** 用語集。未取得なら null。 */
// @implements-old REQ-138
export function useGlossary(): Map<string, GlossaryEntry> | null {
  const g = useSyncExternalStore(subscribe, snapshot)
  useEffect(ensureGlossary, [])
  return g
}

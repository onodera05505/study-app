import { api } from './api'

/** 破棄の結果。`declined` は了承が取り消されたとき、`error` は破棄の要求が失敗したとき。 */
export type DiscardResult = 'discarded' | 'declined' | { error: string }

/** 進行中のテストを破棄する。了承を取ってから DELETE /api/sessions/current を呼ぶ。
 *
 *  破棄は取り消せず、回答済みの分もまとめて消える。1 クリックで消えるのは重いので、
 *  回答済みの問数を示して了承を取る。
 *  失敗は理由を返すだけにして、進行中の案内を消すかどうかは呼び出し側に委ねる。
 *  消せていないのに案内を消すと、進行中が残っていることに気づけない。
 *
 *  進行中のテストを扱う画面（練習テスト・ロードマップ）はどちらもこの 1 本を呼ぶ。 */
// @implements REQ-089, REQ-090, REQ-091, BR-014
export async function discardCurrentSession(answered: number): Promise<DiscardResult> {
  if (!window.confirm(`回答済み ${answered} 問ごと破棄します。よろしいですか？`)) return 'declined'
  try {
    await api('/sessions/current', { method: 'DELETE' })
    return 'discarded'
  } catch (e: any) {
    return { error: e.message }
  }
}

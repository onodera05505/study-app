import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, clearToken, getToken, setToken } from '../lib/api'
import { withoutStorage } from '../lib/storage'
import { portal } from '../../shared/exam'

/** まなびばから戻ってきた使い捨てコードを、この学びのトークンに換える。
 *  端末に前のトークンがあっても、換えられたときだけコードの本人のトークンに入れ替え、
 *  コードが無いか換えられないときは前のトークンに触れない。 */
/** 端末がトークンを保存できなかったときに出す 1 文。 */
const TOKEN_NOT_SAVED = 'この端末にログインの情報を保存できなかったため、ブラウザの設定を確かめてからまなびばでやり直してください。'

// @implements REQ-191, REQ-193, REQ-406, REQ-407
export function SsoCallback({ onDone }: { onDone: () => void }) {
  const [params] = useSearchParams()
  const [error, setError] = useState('')
  useEffect(() => {
    const code = params.get('code')
    if (!code) { setError('コードがありません。まなびばからやり直してください'); return }
    api<{ token: string }>('/auth/sso', { method: 'POST', body: { code }, anonymous: true })
      .then((r) => {
        // 前の本人のトークンと端末の記憶は残さない（BR-010 の捨て方と同じ 1 か所を通す）
        if (getToken()) clearToken()
        // 換えたトークンを端末が保存できなければ、失敗の中身は出さず固定の 1 文とまなびばへ戻る導線を出す
        // @implements REQ-574
        if (!withoutStorage(() => (setToken(r.token), true), false)) {
          setError(TOKEN_NOT_SAVED)
          return
        }
        onDone()
      })
      .catch((e) => setError(e.message))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="center">
      <h1>{error ? 'ログインできませんでした' : 'ログイン中…'}</h1>
      {error ? (
        <>
          <p className="error">{error}</p>
          <a className="btn" href={portal.url}>{portal.name}へ戻る</a>
        </>
      ) : (
        <p className="muted">{portal.name}から戻ってきました。少しお待ちください。</p>
      )}
    </div>
  )
}

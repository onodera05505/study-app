import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, setToken } from '../lib/api'
import { portal } from '../../shared/exam'

/** まなびばから戻ってきた使い捨てコードを、この学びのトークンに換える（要件 §15）。 */
// @implements-old REQ-058
export function SsoCallback({ onDone }: { onDone: () => void }) {
  const [params] = useSearchParams()
  const [error, setError] = useState('')
  useEffect(() => {
    const code = params.get('code')
    if (!code) { setError('コードがありません。まなびばからやり直してください'); return }
    api<{ token: string }>('/auth/sso', { method: 'POST', body: { code } })
      .then((r) => { setToken(r.token); onDone() })
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

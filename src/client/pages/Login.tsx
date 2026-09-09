import { useState } from 'react'
import { api, setToken, takeSessionExpired } from '../lib/api'
import { exam } from '../exam'

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  // 401 で締め出されて戻って来たのかどうか。読んだ時点で印は消えるので、
  // 描き直しても増えないよう初期値としてだけ受け取る。
  const [expired] = useState(takeSessionExpired)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [signupCode, setSignupCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body =
        mode === 'login' ? { email, password } : { email, password, name, signupCode }
      const res = await api<{ token: string }>(`/auth/${mode}`, { method: 'POST', body })
      setToken(res.token)
      onDone()
    } catch (err: any) {
      setError(err.message ?? 'エラーが発生しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <h1>{exam.brand}</h1>
      <p className="lead">
        過去問を起点に、頻出の論点から順に潰していく学習アプリです。
      </p>
      {expired && (
        <div className="notice">
          ログインの有効期限が切れました。もう一度ログインしてください。
        </div>
      )}
      <div className="card">
        {/* type を省くと submit 扱いになる。タブは下のフォームの外にあるが、
            将来フォームの中に入れたときに切り替えたつもりで送信されるので明示する。 */}
        <div className="tabs">
          <button
            type="button"
            className={`btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => setMode('login')}
          >
            ログイン
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => setMode('register')}
          >
            新規登録
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <label>
              <span>お名前</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          <label>
            <span>メールアドレス</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            <span>パスワード（8文字以上）</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {mode === 'register' && (
            <label>
              <span>合言葉（設定されている場合のみ）</span>
              <input value={signupCode} onChange={(e) => setSignupCode(e.target.value)} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? '送信中…' : mode === 'login' ? 'ログイン' : '登録する'}
          </button>
        </form>
        {/* 身内向けなのでパスワード再設定の仕組みは持っていない。
            行き止まりに見えないよう、代わりの手を書いておく。 */}
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.8rem 0 0' }}>
          パスワードを忘れたときは管理者に連絡してください。
        </p>
      </div>
    </div>
  )
}
